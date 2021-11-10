const mediasoup = require('mediasoup');
const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const config = require('./config');
const { resolveObjectURL } = require('buffer');
const { getPort } = require('./port');

const FFmpeg = require('./ffmpeg');
const GStreamer = require('./gstreamer');

const PROCESS_NAME = process.env.PROCESS_NAME || 'FFmpeg';

// Global variables
let worker;
let webServer;
let socketServer;
let expressApp;
let clients = {};
let producers = {};
let consumers = {};
let producerTransports = {};
let consumerTransports = {};
let mediasoupRouter;
let recordingProcesses = {};

(async () => {
  try {
    await runExpressApp();
    await runWebServer();
    await runSocketServer();
    await runMediasoupWorker();
  } catch (err) {
    console.error(err);
  }
})();

async function runExpressApp() {
  expressApp = express();
  expressApp.use(express.json());
  expressApp.use(express.static(__dirname));

  expressApp.use((error, req, res, next) => {
    if (error) {
      console.warn('Express app error,', error.message);

      error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
    } else {
      next();
    }
  });
}

async function runWebServer() {
  const { sslKey, sslCrt } = config;
  if (!fs.existsSync(sslKey) || !fs.existsSync(sslCrt)) {
    console.error('SSL files are not found. check your config.js file');
    process.exit(0);
  }
  const tls = {
    cert: fs.readFileSync(sslCrt),
    key: fs.readFileSync(sslKey),
  };
  webServer = https.createServer(tls, expressApp);
  webServer.on('error', (err) => {
    console.error('starting web server failed:', err.message);
  });

  await new Promise((resolve) => {
    const { listenIp, listenPort } = config;
    webServer.listen(listenPort, listenIp, () => {
      const listenIps = config.mediasoup.webRtcTransport.listenIps[0];
      const ip = listenIps.announcedIp || listenIps.ip;
      console.log('server is running');
      console.log(`open https://${ip}:${listenPort} in your web browser`);
      resolve();
    });
  });
}

function getProducerCount() {
  return Object.keys(producers).filter(id => producers[id]).length;
}

function getConsumerCount() {
  return Object.keys(consumers).filter(id => consumers[id]).length;
}

function sendStats() {
  socketServer.emit('stats', {producerCount: getProducerCount(), consumerCount: getConsumerCount()});
}

async function runSocketServer() {
  socketServer = socketIO(webServer, {
    serveClient: false,
    path: '/server',
    log: false,
  });

  setInterval(() => sendStats(), 1000);

  socketServer.on('connection', (socket) => {
    const username = socket.handshake.query.username;

    console.info('client connected -> ' + username);
    
    clients[socket.id] = { socket: socket, username: username, producers: [], consumers: [], producerTransports: [], consumerTransports: [] }; 
    
    socket.broadcast.emit('newUser', { username });

    const allProducers = Object.keys(producers).filter(producerId => producers[producerId]).map(producerId => {
      const producer = producers[producerId];
      return { id: producer.id, kind: producer.kind, username: username };
    });

    socket.emit('welcome', { users: Object.keys(clients).filter(socketId => clients[socketId]).map(socketId => clients[socketId].username), producers: allProducers });

    socket.on('disconnect', (reason) => {
      console.log('client disconnected', reason);
      
      clients[socket.id].producers.forEach(producerId => {
        if (producers[producerId]) {
          console.log('deleting producer ' + producerId);
          producers[producerId] = null;
          Object.keys(consumers).filter(id => consumers[id] && consumers[id].producerId === producerId).forEach(id => {
            const consumer = consumers[id];
            consumer.close();
            consumers[id] = null;
          });
        }
      });

      // send to other clients
      socket.broadcast.emit('client_disconnect', {id: socket.id, producers: clients[socket.id].producers, username });

      clients[socket.id] = null;
    });

    socket.on('connect_error', (err) => {
      console.error('client connection error', err);
    });

    socket.on('getRouterRtpCapabilities', (data, callback) => {
      callback(mediasoupRouter.rtpCapabilities);
    });

    socket.on('createProducerTransport', async (data, callback) => {
      console.info('createProducerTransport', data);
      try {
        const { transport, params } = await createWebRtcTransport();

        console.info('producerTransport created ' + transport.id);

        producerTransports[transport.id] = transport;
        clients[socket.id].producerTransports.push(transport.id);

        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('createConsumerTransport', async (data, callback) => {
      // console.info('createConsumerTransport', data);

      try {
        const { transport, params } = await createWebRtcTransport();
        
        // console.info('consumerTransport created ' + transport.id, params);
        console.info('consumerTransport created ' + transport.id);

        consumerTransports[transport.id] = transport;
        clients[socket.id].consumerTransports.push(transport.id);

        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('connectProducerTransport', async (data, callback) => {
      console.info('connectProducerTransport', data);
      const producerTransport = producerTransports[data.id];
      await producerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on('connectConsumerTransport', async (data, callback) => {
      console.info('connectConsumerTransport', data);
      const consumerTransport = consumerTransports[data.id];
      await consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on('produce', async (data, callback) => {
      console.info('produce', data);
      const {kind, rtpParameters, id} = data;
      const producerTransport = producerTransports[data.transportId];
      const producer = await producerTransport.produce({ kind, rtpParameters, id });

      producers[producer.id] = producer;

      clients[socket.id].producers.push(producer.id);

      callback({ id: producer.id });

      startRecord(producer.id);

      // inform clients about new producer
      socket.broadcast.emit('newProducer', { 'id': producer.id, 'kind': producer.kind, 'username': data.username });
    });

    socket.on('consume', async (data, callback) => {
      // console.info('consume', data);
      const producer = producers[data.producerId];
      const consumerTransport = consumerTransports[data.transportId];
      callback(await createConsumer(socket, consumerTransport, producer, data.rtpCapabilities));
    });

    socket.on('resume', async (data, callback) => {
      // console.info('resume', data);
      try {
        const consumer = consumers[data.consumerId];
        await consumer.resume();
        callback();
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });
  });
}

async function runMediasoupWorker() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  mediasoupRouter = await worker.createRouter({ mediaCodecs });
}

async function createWebRtcTransport() {
  
  const {
    maxIncomingBitrate,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

  const transport = await mediasoupRouter.createWebRtcTransport({
    listenIps: config.mediasoup.webRtcTransport.listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate,
  });

  console.info('createWebRtcTransport -> transport created', transport);

  if (maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    } catch (error) {
    }
  }
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    },
  };
}

async function createConsumer(socket, consumerTransport, producer, rtpCapabilities) {
  if (!producer) {
    console.warn('producer is null');
    return null;
  }
  if (!mediasoupRouter.canConsume(
    {
      producerId: producer.id,
      rtpCapabilities,
    })
  ) {
    console.error('can not consume');
    return;
  }

  let consumer = null;

  try {
    consumer = await consumerTransport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: producer.kind === 'video',
    });

    consumers[consumer.id] = consumer;

    clients[socket.id].consumers.push(consumer.id);

    consumer.on('producerclose', () => {
      console.log('producerclose consumerId: ' + consumer.id + ' producerId: ' + producerId);
      consumers[consumer.id] = null;
    })

  } catch (error) {
    console.error('consume failed', error);
    return;
  }

  if (consumer.type === 'simulcast') {
    await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
  }

  return {
    producerId: producer.id,
    id: consumer.id,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    type: consumer.type,
    producerPaused: consumer.producerPaused
  };
}

const startRecord = async (producerId) => {
  let recordInfo = {};

  const producer = producers[producerId];

  if (!producer) {
    console.error('startRecord: producer does not exist. producerId: ' + producerId);
    return;
  }

  if (recordingProcesses[producerId]) {
    console.warn('startRecord: recording already exits. producerId: ' + producerId);
    return;
  }

  recordInfo[producer.kind] = await publishProducerRtpStream(producer);

  recordInfo.fileName = producerId; // Date.now().toString()

  // peer.process = getProcess(recordInfo);
  recordingProcesses[producerId] = getProcess(recordInfo);

  // Sometimes the consumer gets resumed before the GStreamer process has fully started
  // so wait a couple of seconds
  setTimeout(async () => {
    Object.keys(consumers)
      .forEach(consumerId => { 
          const consumer = consumers[consumerId];
          if (consumer && consumer.producerId === producerId) {
            consumer.resume();
          }
        }
      )
  }, 1000);
  
};

const publishProducerRtpStream = async (producer, ffmpegRtpCapabilities) => {
  console.log('publishProducerRtpStream()');

  // Create the mediasoup RTP Transport used to send media to the GStreamer process
  const rtpTransportConfig = config.mediasoup.plainRtpTransport;

  // If the process is set to GStreamer set rtcpMux to false
  if (PROCESS_NAME === 'GStreamer') {
    rtpTransportConfig.rtcpMux = false;
  }

  // const rtpTransport = await createTransport('plain', router, rtpTransportConfig);
  const rtpTransport =  await mediasoupRouter.createPlainRtpTransport(config.mediasoup.plainRtpTransport);

  // Set the receiver RTP ports
  const remoteRtpPort = await getPort();
  
  // peer.remotePorts.push(remoteRtpPort);

  let remoteRtcpPort;
  // If rtpTransport rtcpMux is false also set the receiver RTCP ports
  if (!rtpTransportConfig.rtcpMux) {
    remoteRtcpPort = await getPort();
    // peer.remotePorts.push(remoteRtcpPort);
  }


  // Connect the mediasoup RTP transport to the ports used by GStreamer
  await rtpTransport.connect({
    ip: '127.0.0.1',
    port: remoteRtpPort,
    rtcpPort: remoteRtcpPort
  });

  // peer.addTransport(rtpTransport);

  const codecs = [];
  // Codec passed to the RTP Consumer must match the codec in the Mediasoup router rtpCapabilities
  const routerCodec = mediasoupRouter.rtpCapabilities.codecs.find(
    codec => codec.kind === producer.kind
  );
  codecs.push(routerCodec);

  const rtpCapabilities = {
    codecs,
    rtcpFeedback: []
  };

  // Start the consumer paused
  // Once the gstreamer process is ready to consume resume and send a keyframe
  const rtpConsumer = await rtpTransport.consume({
    producerId: producer.id,
    rtpCapabilities,
    paused: true
  });

  console.info('recording consumer created -> ' + rtpConsumer.id  + ' producerId: ' + producer.id)
  // peer.consumers.push(rtpConsumer);
  consumers[rtpConsumer.id] = rtpConsumer;

  return {
    remoteRtpPort,
    remoteRtcpPort,
    localRtcpPort: rtpTransport.rtcpTuple ? rtpTransport.rtcpTuple.localPort : undefined,
    rtpCapabilities,
    rtpParameters: rtpConsumer.rtpParameters
  };
};

// Returns process command to use (GStreamer/FFmpeg) default is FFmpeg
const getProcess = (recordInfo) => {
  switch (PROCESS_NAME) {
    case 'GStreamer':
      return new GStreamer(recordInfo);
    case 'FFmpeg':
    default:
      return new FFmpeg(recordInfo);
  }
};
