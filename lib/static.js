"use strict";

const fs           = require('fs');
const Throttle     = require('stream-throttle').Throttle;
const merge        = require('mout/object/merge');

const Server       = require('./_server');

class StaticFeed extends Server {

  constructor(server, opts) {
    super(server, merge({
      video_path     : null,
      video_duration : 0,
    }, opts));
  }

  get_feed(spiltNalUnit) {
    var source = this.options.video_path;
    var readStream = fs.createReadStream(source);

    //throttle for "real time simulation"
    if (spiltNalUnit) {
      var sourceThrottleRate = Math.floor(fs.statSync(source)['size'] / this.options.video_duration);
      console.log("Generate a throttle rate of %s kBps", Math.floor(sourceThrottleRate/1024));
      readStream = readStream.pipe(new Throttle({rate: sourceThrottleRate}));
    }

    console.log("Generate a static feed from ", source);
    return readStream;
  }

}




module.exports = StaticFeed;
