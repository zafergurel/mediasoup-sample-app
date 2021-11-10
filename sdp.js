const { getCodecInfoFromRtpParameters } = require('./utils');

// File to create SDP text from mediasoup RTP Parameters
module.exports.createSdpText = (rtpParameters) => {
  const { video, audio } = rtpParameters;
  
  // Video codec info
  let videoCodecInfo = null;
  if (video) {
    videoCodecInfo = getCodecInfoFromRtpParameters('video', video.rtpParameters);
  }
  
  let audioCodecInfo = null;
  if (audio) {
    // Audio codec info
    audioCodecInfo = getCodecInfoFromRtpParameters('audio', audio.rtpParameters);
  }
  
  let sdp = `v=0
  o=- 0 0 IN IP4 127.0.0.1
  s=FFmpeg
  c=IN IP4 127.0.0.1
  t=0 0`;

  if (videoCodecInfo) {
      sdp += `
  m=video ${video.remoteRtpPort} RTP/AVP ${videoCodecInfo.payloadType} 
  a=rtpmap:${videoCodecInfo.payloadType} ${videoCodecInfo.codecName}/${videoCodecInfo.clockRate}
  a=sendonly`;
  }
  
  if (audioCodecInfo) {
    sdp += `
  m=audio ${audio.remoteRtpPort} RTP/AVP ${audioCodecInfo.payloadType} 
  a=rtpmap:${audioCodecInfo.payloadType} ${audioCodecInfo.codecName}/${audioCodecInfo.clockRate}/${audioCodecInfo.channels}
  a=sendonly`;
    }

  return sdp;
};