"use strict";

var Avc            = require('../broadway/Decoder');
var YUVWebGLCanvas = require('../canvas/YUVWebGLCanvas');
var YUVCanvas      = require('../canvas/YUVCanvas');
var Size           = require('../utils/Size');
var Class          = require('uclass');
var Events         = require('uclass/events');
var debug          = require('debug');
var log            = debug("wsavc");

var WSAvcPlayer = new Class({
  Implements : [Events],


  initialize : function(canvas, canvastype, splitNalUnit) {

    this.canvas     = canvas;
    this.canvastype = canvastype;
    this.splitNalUnit = splitNalUnit;
    this.rawVideo = [];
    this.frames = [];
    this.intervalIds = [];
    this.mlock = false;
    this.now = Date.now();
    this.second_acc = 0;
    this.frame_acc = 0;
    this.call_acc = 0;
    this.fps_avg = 10;


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
    var naltype = "invalid frame";

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
    //log("Passed " + naltype + " to decoder");
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

    this.ws.onopen = () => {
      log("Connected to " + url);
    };

    var decodeWSBinary = function (data) {
      if (!this.splitNalUnit) {
        this.pktnum++;
        var frame = new Uint8Array(data);
        this.frames.push(frame);
      } else {
        if (this.mlock) {
          return decodeWSBinary(data);
        }
        this.mlock = true;

        // copy data to raw video
        var videoFrame = new Uint8Array(data);
        this.rawVideo.push.apply(this.rawVideo, videoFrame)
        this.mlock = false;
      }
    }.bind(this);

    var decodeVideoFrame = function() {
      if (this.mlock) {
        return;
      }
      this.mlock = true;
      var start = 0;
      var end = 0;
      var totalLength = this.rawVideo.length;

      // 1 Second passed
      var now = Date.now();
      this.second_acc += now - this.now;
      this.now = now;
      if (this.second_acc > 1000) {
        this.second_acc -= 1000;
        var fps = this.frame_acc;
        this.fps_avg = (this.fps_avg*4 + fps) / 5;
        this.frame_acc = 0;
        this.call_acc = 0;
      }

      for (var i=3; i<totalLength; i++) {
        if (this.rawVideo[i] == 1 && this.rawVideo[i-1] == 0 && this.rawVideo[i-2] == 0 && this.rawVideo[i-3] == 0) {
          if (start == 0) {
            start = i + 1;
          } else {
            end = i - 3;
            var frame = new Uint8Array(this.rawVideo.slice(start - 4, end))
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

    this.ws.onmessage = (evt) => {
      if(typeof evt.data == "string")
        return this.cmd(JSON.parse(evt.data));

      decodeWSBinary(evt.data);
    };

    window.player = this;
    var running = true;
    var ts = Date.now();

    var shiftFrame = function(timestamp) {
      if(!running)
        return;

      var incr = timestamp - ts;
      ts = timestamp;          
  
      if(this.frames.length > 100) {
        log("Dropping frames", this.frames);
        this.frames = this.frames.slice(70);
      }

      this.call_acc -= this.fps_avg / (1000 / incr);
      if (this.call_acc < 0) {
        var frame = this.frames.shift();
        if (frame) {
          this.call_acc++;
          this.decode(frame);
        }
      }

      requestAnimationFrame(shiftFrame);
    }.bind(this);

    shiftFrame();

    this.ws.onclose = () => {
      running = false;
      log("WSAvcPlayer: Connection closed")
    };

  },

  initCanvas : function(width, height) {
    var canvasFactory = this.canvastype == "webgl" || this.canvastype == "YUVWebGLCanvas"
                        ? YUVWebGLCanvas
                        : YUVCanvas;

    var canvas = new canvasFactory(this.canvas, new Size(width, height));
    this.avc.onPictureDecoded = canvas.decode;
    this.emit("canvasReady", width, height);
  },

  cmd : function(cmd){
    log("Incoming request", cmd);

    if(cmd.action == "init") {
      this.initCanvas(cmd.width, cmd.height);
      this.canvas.width  = cmd.width;
      this.canvas.height = cmd.height;
    }
  },

  disconnect : function() {
    this.ws.close();
    this.intervalIds.forEach(function (id) {
      window.clearInterval(id);
    });
  },

  playStream : function() {
    var message = "";
    if (this.splitNalUnit) {
      message = "REQUESTRAWSTREAM ";
    } else {
      message = "REQUESTSTREAM ";
    }
    this.ws.send(message);
    log("Sent " + message);
  },


  stopStream : function() {
    this.ws.send("STOPSTREAM");
    log("Sent STOPSTREAM");
  },

  pushRawVideo : function(rawVideoFrame) {
    if (rawVideoFrame.length <= 0) {
      return
    }
    rawVideoFrame = new Uint8Array(rawVideoFrame);
    for (var i=0; i<rawVideoFrame.length; i++) {
      this.rawVideo.push(rawVideoFrame[i]);
    }
  },
});


module.exports = WSAvcPlayer;
module.exports.debug = debug;
