const mediasoup = require('mediasoup-client');
const socketClient = require('socket.io-client');
const socketPromise = require('./lib/socket.io-promise').promise;
const config = require('./config');

const hostname = window.location.hostname;

let device;
let socket;
let videoProducer;
let audioProducer;

const $ = document.querySelector.bind(document);
const $fsPublish = $('#fs_publish');
const $btnConnect = $('#btn_connect');
const $btnWebcam = $('#btn_webcam');
const $btnScreen = $('#btn_screen');
const $chkSimulcast = $('#chk_simulcast');
const $txtConnection = $('#connection_status');
const $txtWebcam = $('#webcam_status');
const $txtAudio = $('#audio_status');
const $txtScreen = $('#screen_status');

const $subButtons = $('#subButtons');
const $videos = $('#videos');

let $txtPublish;

$btnConnect.addEventListener('click', connect);
$btnWebcam.addEventListener('click', publish);
$btnScreen.addEventListener('click', publish);

let username = '';

if (typeof navigator.mediaDevices.getDisplayMedia === 'undefined') {
  $txtScreen.innerHTML = 'Not supported';
  $btnScreen.disabled = true;
}

document.addEventListener('readystatechange', e => {
  if (e.target.readyState === 'complete') { 
    connect();
  }
});

function getProducerId(mediaType) {
  return username + '_' + mediaType + '_' + (new Date()).toISOString().replace(/[-T:]/g, '').replace(/\..+$/, '');
}

async function connect() {
  while (!/^[\d\w]+$/.test(username)) {
    username = prompt('Adınızı giriniz. Sadece karakter ve sayı olsun. Türkçe karakter olmasın. Boşluk olmasın.');
  }

  $btnConnect.disabled = true;
  $txtConnection.innerHTML = 'Connecting...';

  const opts = {
    path: '/server',
    transports: ['websocket'],
    query: {
      username: username,
    }    
  };
  
  // client listen port may be different than server listening port.
  const listenPort = config.clientListenPort ? config.clientListenPort : config.listenPort;

  const serverUrl = `https://${hostname}:${listenPort}`;
  socket = socketClient(serverUrl, opts);
  socket.request = socketPromise(socket);

  socket.on('connect', async () => {
    $txtConnection.innerHTML = 'Connected';
    $fsPublish.disabled = false;

    const data = await socket.request('getRouterRtpCapabilities');
    await loadDevice(data);
  });

  socket.on('disconnect', () => {
    $txtConnection.innerHTML = 'Disconnected';
    $btnConnect.disabled = false;
    $fsPublish.disabled = true;
    $subButtons.innerHTML = '';
  });

  socket.on('connect_error', (error) => {
    console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
    $txtConnection.innerHTML = 'Connection failed ' + error.message;
    $btnConnect.disabled = false;
  });

  socket.on('newProducer', handleNewProducer);

  socket.on('client_disconnect', (clientInfo) => {
    console.log('client_disconnect', clientInfo);
    if (clientInfo.producers) {
      clientInfo.producers.forEach(producerId => {
        const container = $('#container_' + producerId);
        if (container) {
          $('#container_' + producerId).remove();
        }
        
        const medias = [...document.querySelectorAll('.media')];

        if (medias) {
          medias.filter(m => m.dataset.producerId === producerId).forEach(media => {
            media.remove();
          })
        }
      });
    }
    const userSpan = $('#' + clientInfo.username);
    if (userSpan) {
      userSpan.remove();
    }
  });

  socket.on('stats', stats => {
    $('#publisher_count').innerText = stats.producerCount;
    $('#viewer_count').innerText = stats.consumerCount;
  });

  socket.on('newUser', userInfo => {
    const userSpan = document.createElement('span');
    userSpan.id = userInfo.username;
    userSpan.className = 'user';
    userSpan.innerText = userInfo.username;
    $('#fs_users').appendChild(userSpan);
  });

  socket.on('welcome', data => {
    data.users.forEach(username => {
      const userSpan = document.createElement('span');
      userSpan.id = username;
      userSpan.className = 'user';
      userSpan.innerText = username;
      $('#fs_users').appendChild(userSpan);
    })

    data.producers.forEach(handleNewProducer);
    
  });
}

const handleNewProducer = (producerInfo) => {
  console.log('newProducer -> producerInfo: ' + JSON.stringify(producerInfo));

  const container = document.createElement("div");
  container.id = 'container_' + producerInfo.id;

  const textbox = document.createElement("input");
  textbox.id = 'txt_count_' + producerInfo.id;
  textbox.className = 'txt_count';
  textbox.value = '1';
  
  const button = document.createElement("button");
  button.innerText = "Subscribe";
  button.id = 'btn_subscribe_' + producerInfo.id;
  button.dataset.id = producerInfo.id;
  button.dataset.kind = producerInfo.kind;
  button.disabled = false;
  button.addEventListener('click', subscribeHandler);

  const span = document.createElement("span");
  span.id = 'sub_status_' + producerInfo.id;
  span.innerText = producerInfo.id + ' (' + producerInfo.kind + ')';
  
  container.appendChild(textbox);
  container.appendChild(button);
  container.appendChild(span);
  $subButtons.appendChild(container);
};

async function loadDevice(routerRtpCapabilities) {
  try {
    device = new mediasoup.Device();
  } catch (error) {
    if (error.name === 'UnsupportedError') {
      console.error('browser not supported');
    }
  }
  await device.load({ routerRtpCapabilities });
}

async function publish(e) {
  const isWebcam = (e.target.id === 'btn_webcam');
  $txtPublish = isWebcam ? $txtWebcam : $txtScreen;

  const videoData = await socket.request('createProducerTransport', {
    forceTcp: config.forceTcp,
    rtpCapabilities: device.rtpCapabilities,
  });

  let audioData = null;

  if (videoData.error) {
    console.error(data.error);
    return;
  }

  if (isWebcam) {
    audioData = await socket.request('createProducerTransport', {
      forceTcp: config.forceTcp,
      rtpCapabilities: device.rtpCapabilities,
    });;

    if (audioData.error) {
      console.error(data.error);
      return;
    }
  }

  const videoTransport = device.createSendTransport(videoData);

  console.log('videoTransport created', videoTransport);

  let audioTransport = null;
  
  if (isWebcam) {

    /*
    audioTransport = device.createSendTransport(audioData);

    console.log('audioTransport created', audioTransport);

    audioTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      socket.request('connectProducerTransport', { dtlsParameters, id: audioTransport.id })
        .then(callback)
        .catch(errback);
    });
  
    audioTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
      const producerId = getProducerId('a');
      try {
        const { id } = await socket.request('produce', {
          transportId: audioTransport.id,
          kind,
          rtpParameters,
          id: producerId
        });
        callback({ id });
      } catch (err) {
        errback(err);
      }
    });
  
    audioTransport.on('connectionstatechange', (state) => {
      switch (state) {
        case 'connecting':
          $txtAudio.innerHTML = 'publishing audio...';
        break;
  
        case 'connected':
          $txtAudio.innerHTML = 'published audio';
        break;

        case 'failed':
          audioTransport.close();
          $txtAudio.innerHTML = 'failed audio';
        break;
  
        default: break;
      }
    });
  }
*/

  videoTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    socket.request('connectProducerTransport', { dtlsParameters, id: videoTransport.id })
      .then(callback)
      .catch(errback);
  });

  videoTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
    try {
      const producerId = getProducerId('c');
      const { id } = await socket.request('produce', {
        transportId: videoTransport.id,
        kind,
        rtpParameters,
        id: producerId,
      });
      callback({ id });
    } catch (err) {
      errback(err);
    }
  });

  videoTransport.on('connectionstatechange', (state) => {
    switch (state) {
      case 'connecting':
        $txtPublish.innerHTML = 'publishing...';
        $fsPublish.disabled = true;
      break;

      case 'connected':
        document.querySelector('#local_video').srcObject = stream;
        $txtPublish.innerHTML = 'published';
        $fsPublish.disabled = true;
      break;

      case 'failed':
        videoTransport.close();
        $txtPublish.innerHTML = 'failed';
        $fsPublish.disabled = false;
      break;

      default: break;
    }
  });

  let stream;
  try {
    stream = await getUserMedia(isWebcam);
    const videoTrack = stream.getVideoTracks()[0];
    let audioTrack = null;

    const params = { track: videoTrack };
    if ($chkSimulcast.checked) {
      params.encodings = [
        { maxBitrate: 100000 },
        { maxBitrate: 300000 },
        { maxBitrate: 900000 },
      ];
      params.codecOptions = {
        videoGoogleStartBitrate : 1000
      };
    }
    videoProducer = await videoTransport.produce(params);

    if (stream.getAudioTracks().length > 0) {
      
      audioTrack = stream.getAudioTracks()[0];
      console.log('audio track', audioTrack);

      const audioParams = { track: audioTrack };
      
      audioProducer = await videoTransport.produce(audioParams);
    }

  } catch (err) {
    $txtPublish.innerHTML = 'video failed ' + err.toString();
  }

  /*
  try {
    if (stream.getAudioTracks().length > 0) {
      
      const audioTrack = stream.getAudioTracks()[0];
      console.log('audio track', audioTrack);

      const audioParams = { track: audioTrack };
      
      audioProducer = await audioTransport.produce(audioParams);
    }
  } catch(err) {
    $txtAudio.innerHTML = 'audio failed ' + err.toString();
  }*/
}

async function getUserMedia(isWebcam) {
  if (!device.canProduce('video')) {
    console.error('cannot produce video');
    return;
  }

  let stream;
  try {
    stream = isWebcam ?
      await navigator.mediaDevices.getUserMedia({ video: true, audio: true }) :
      await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    console.error('getUserMedia() failed:', err.message);
    throw err;
  }
  return stream;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function subscribeHandler(e) {
  
  const producerId = e.currentTarget.dataset.id;
  const count = parseInt($('#txt_count_' + producerId).value);

  if (!count) {
    count = 1;
  }

  console.log('subscribe to ' + producerId + ' ' + count + ' times');

  for(let i=0; i < count; i++) {
    await subscribe(producerId);
    await delay(500);
  }
}

async function subscribe(producerId) {
  const data = await socket.request('createConsumerTransport', {
    forceTcp: config.forceTcp,
  });

  console.log('subscribe -> transport data', data);

  if (!data) {
    console.error('data is null for ' + producerId);
    return;
  }

  if (data.error) {
    console.error(data.error);
    return;
  }

  const transport = device.createRecvTransport(data);

  console.log('subscribe -> createRecvTransport', transport);

  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    console.log('connect transport: ' + transport.id);
    socket.request('connectConsumerTransport', {
      id: transport.id,
      dtlsParameters
    })
      .then(callback)
      .catch(errback);
  });

  transport.on('connectionstatechange', async (state) => {
    console.log('connectionstatechange transport: ' + transport.id + ' state: ' + state);
    switch (state) {
      case 'connecting':
        $('#sub_status_' + producerId).innerHTML = 'subscribing...';
        // $('#btn_subscribe_' + producerId).disabled = true;
        break;

      case 'connected':
        const streamInfo = await fnConsume;
        const response = await socket.request('resume', { consumerId: streamInfo.consumerId });
        if (response && response.error) {
          $('#sub_status_' + producerId).innerHTML = 'error';
        } else {
          $('#sub_status_' + producerId).innerHTML = 'subscribed';
        }
        
        // $('#btn_subscribe_' + producerId).disabled = true;
        break;

      case 'failed':
        transport.close();
        $('#sub_status_' + producerId).innerHTML = 'failed';
        $('#btn_subscribe_' + producerId).disabled = false;
        break;

      default: break;
    }
  });

  const fnConsume = consume(transport, producerId);
}

async function consume(transport, theProducerId) {
  const { rtpCapabilities } = device;
  const data = await socket.request('consume', { rtpCapabilities, producerId: theProducerId, transportId: transport.id });

  console.log('consume', data);

  const {
    producerId,
    id,
    kind,
    rtpParameters,
  } = data;

  let codecOptions = {};
  const consumer = await transport.consume({
    id,
    producerId,
    kind,
    rtpParameters,
    codecOptions,
  });

  const streamInfo = { stream: new MediaStream(), consumerId: id };
  streamInfo.stream.addTrack(consumer.track);

  if (kind === 'audio') {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = streamInfo.stream;
    audio.dataset.kind = kind;
    audio.dataset.id = id;
    audio.dataset.producerId = producerId;
    audio.id = 'media_' + producerId + '_' + id;
    audio.className = 'media';
    $videos.appendChild(audio);
  } else {
    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = streamInfo.stream;
    video.dataset.kind = kind;
    video.dataset.id = id;
    video.dataset.producerId = producerId;
    video.className = 'media';
    video.id = 'media_' + producerId + '_' + id;
  
    $videos.appendChild(video);
  }
  
  
  return streamInfo;
}
