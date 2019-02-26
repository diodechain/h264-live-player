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
        for (var i=0; i<videoFrame.length; i++) {
          this.rawVideo.push(videoFrame[i]);
        }
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
      var nal = [0,0,0,1];
      var nalLength = nal.length;

      for (var i=start; i<totalLength; i++) {
        var isMatch = true;
        for (var j=0; j<nal.length; j++) {
            if (this.rawVideo[i+j] != nal[j]) {
            isMatch = false
            break
            }
        }
        if (isMatch) {
            if (start == 0) {
              start = i + nalLength
            } else {
              end = i
              break
            }
        } else if (j > 0) {
            i += j
        }
      }
      if (start >= 0 && end > 0) {
        // got data
        var frame = new Uint8Array(this.rawVideo.splice(start - nalLength, end))
        this.pktnum++;
        this.frames.push(frame);
      }
      this.mlock = false;
    }.bind(this);

    // decode video frame
    this.intervalIds.push(window.setInterval(decodeVideoFrame, 90));

    this.ws.onmessage = (evt) => {
      if(typeof evt.data == "string")
        return this.cmd(JSON.parse(evt.data));

      decodeWSBinary(evt.data);
    };

    var running = true;

    var shiftFrame = function() {
      if(!running)
        return;

      if(this.frames.length > 10) {
        log("Dropping frames", this.frames);
        this.frames = [];
      }

      var frame = this.frames.shift();

      if(frame)
        this.decode(frame);

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
