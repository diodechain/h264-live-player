"use strict";

let Avc            = require('../broadway/Decoder');
let YUVWebGLCanvas = require('../canvas/YUVWebGLCanvas');
let YUVCanvas      = require('../canvas/YUVCanvas');
let Size           = require('../utils/Size');
let Class          = require('uclass');
let Events         = require('uclass/events');
let debug          = require('debug');
let log            = debug("wsavc");

let WSAvcPlayer = new Class({
  Implements : [Events],


  initialize : function(canvas, canvasType, splitNalUnit, fps, debugMode) {

    this.canvas     = canvas;
    this.canvasType = canvasType;
    this.splitNalUnit = splitNalUnit || false;
    this.fps_avg = parseInt(fps) || 10;
    this.debugMode = debugMode || false;
    this.rawVideo = [];
    this.frames = [];
    this.intervalIds = [];
    this.mlock = false;
    this.now = Date.now();
    this.second_acc = 0;
    this.frame_acc = 0;
    this.call_acc = 0;

    if (!this.canvas) {
      this.canvas = this.createCanvas();
    }


    // AVC codec initialization
    this.avc = new Avc();
    // if(false) this.avc.configure({
    //   filter: "original",
    //   filterHorLuma: "optimized",
    //   filterVerLumaEdge: "optimized",
    //   getBoundaryStrengthsA: "optimized"
    // });

    //WebSocket variable
    this.ws;
    this.pktnum = 0;

  },


  decode : function(data) {
    let naltype = "invalid frame";

    if (data.length > 4) {
      if (data[4] == 0x65) {
        naltype = "I frame";
      }
      else if (data[4] == 0x41) {
        naltype = "P frame";
      }
      else if (data[4] == 0x67) {
        naltype = "SPS";
      }
      else if (data[4] == 0x68) {
        naltype = "PPS";
      }
    }
    if (this.debugMode) {
      log("Passed " + naltype + " to decoder");
    }
    this.avc.decode(data);
  },

  connect : function(url) {

    // Websocket initialization
    if (this.ws != undefined) {
      this.ws.close();
      delete this.ws;
    }
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = function () {
      if (this.debugMode) {
        log("Connected to " + url);
      }
      this.emit('connected')
    }.bind(this);

    let decodeWSBinary = function (data) {
      if (!this.splitNalUnit) {
        this.pktnum++;
        let frame = new Uint8Array(data);
        this.frames.push(frame);
      } else {
        if (this.mlock) {
          return decodeWSBinary(data);
        }
        this.mlock = true;

        // copy data to raw video
        let videoFrame = new Uint8Array(data);
        this.rawVideo.push.apply(this.rawVideo, videoFrame)
        this.mlock = false;
      }
    }.bind(this);

    let decodeVideoFrame = function() {
      if (this.mlock) {
        return;
      }
      this.mlock = true;
      let start = 0;
      let end = 0;
      let totalLength = this.rawVideo.length;

      // 1 Second passed
      let now = Date.now();
      this.second_acc += now - this.now;
      this.now = now;
      if (this.second_acc > 1000) {
        this.second_acc -= 1000;
        let fps = this.frame_acc;
        this.fps_avg = (this.fps_avg*4 + fps) / 5;
        this.frame_acc = 0;
        this.call_acc = 0;
      }

      for (let i=3; i<totalLength; i++) {
        if (this.rawVideo[i] == 1 && this.rawVideo[i-1] == 0 && this.rawVideo[i-2] == 0 && this.rawVideo[i-3] == 0) {
          if (start == 0) {
            start = i + 1;
          } else {
            end = i - 3;
            let frame = new Uint8Array(this.rawVideo.slice(start - 4, end))
            this.pktnum++;
            this.frames.push(frame);
            start = end + 4;
            end = 0;

            this.frame_acc++;
          }
        }
      }
      if (start > 0) {
          this.rawVideo = this.rawVideo.slice(start - 4);
      } else if (this.rawVideo.length > 3) {
          this.rawVideo = this.rawVideo.slice(this.rawVideo.length - 3);
      }
      this.mlock = false;
    }.bind(this);

    // decode video frame
    this.intervalIds.push(window.setInterval(decodeVideoFrame, 100));

    this.ws.onmessage = function (evt) {
      if(typeof evt.data == "string")
        return this.cmd(JSON.parse(evt.data));

      decodeWSBinary(evt.data);
    };

    window.player = this;
    let running = true;
    let ts = Date.now();

    let shiftFrame = function(timestamp) {
      if(!running)
        return;

      let incr = timestamp - ts;
      ts = timestamp;          
  
      if(this.frames.length > 100) {
        if (this.debugMode) {
          log("Dropping frames", this.frames);
        }
        this.frames = this.frames.slice(70);
      }

      this.call_acc -= this.fps_avg / (1000 / incr);
      if (this.call_acc < 0) {
        let frame = this.frames.shift();
        if (frame) {
          this.call_acc++;
          this.decode(frame);
        }
      }

      requestAnimationFrame(shiftFrame);
    }.bind(this);

    shiftFrame();

    this.ws.onclose = function () {
      running = false;
      if (this.debugMode) {
        log("WSAvcPlayer: Connection closed")
      }
      this.emit("close");
    }.bind(this);

  },

  initCanvas : function(width, height) {
    let canvasFactory = this.canvasType == "webgl" || this.canvasType == "YUVWebGLCanvas"
                        ? YUVWebGLCanvas
                        : YUVCanvas;

    let canvas = new canvasFactory(this.canvas, new Size(width, height));
    this.avc.onPictureDecoded = canvas.decode;
    this.emit("canvasReady", width, height);
  },

  createCanvas : function() {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    return canvas
  },

  disconnect : function() {
    this.ws.close();
    this.intervalIds.forEach(function (id) {
      window.clearInterval(id);
    });
  },

  pushRawVideo : function(rawVideoFrame) {
    if (rawVideoFrame.length <= 0) {
      return
    }
    rawVideoFrame = new Uint8Array(rawVideoFrame);
    for (let i=0; i<rawVideoFrame.length; i++) {
      this.rawVideo.push(rawVideoFrame[i]);
    }
  },
});


module.exports = WSAvcPlayer;
module.exports.debug = debug;