/* Safari/Chrome audio starts in a real tap, before Godot's asynchronous startup. */
(() => {
  'use strict';
  const NativeContext = window.AudioContext || window.webkitAudioContext;
  const contexts = [];
  const qa = new URLSearchParams(location.search).has('qa');
  const meters = new Map();
  let prepared = null, legacyAudio = null;
  const errors = [], starts = [];
  const connections = [], quanta = {calls: 0, peak: 0, nonzero: 0};
  const isAppleTouch = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function report(error) { errors.push(String(error)); }
  function track(context) {
    if (!contexts.includes(context)) {
      contexts.push(context);
      if (qa) {
        const meter = context.createAnalyser();
        meter.fftSize = 2048;
        meters.set(context, meter);
      }
      context.addEventListener('statechange', update);
    }
    return context;
  }
  if (NativeContext) {
    function GameAudioContext(options) {
      const context = prepared && prepared.state !== 'closed' ? prepared : new NativeContext(options);
      prepared = null;
      return track(context);
    }
    GameAudioContext.prototype = NativeContext.prototype;
    Object.setPrototypeOf(GameAudioContext, NativeContext);
    window.AudioContext = GameAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = GameAudioContext;
  }
  // QA observes an additional branch of the real destination graph. It never
  // supplies a test oscillator or substitutes for the game's audio players.
  if (qa && window.AudioNode) {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(destination, ...args) {
      const result = connect.call(this, destination, ...args);
      const meter = meters.get(this.context);
      if (connections.length<30) connections.push({from:this.constructor.name,to:destination.constructor.name,output:destination===this.context.destination});
      if (meter && destination === this.context.destination && this !== meter) {
        connect.call(this, meter);
      }
      return result;
    };
    const makeProcessor=NativeContext.prototype.createScriptProcessor;
    if (makeProcessor && window.ScriptProcessorNode) {
      NativeContext.prototype.createScriptProcessor=function(...args) {
        const node=makeProcessor.apply(this,args);
        const descriptor=Object.getOwnPropertyDescriptor(ScriptProcessorNode.prototype,'onaudioprocess');
        let handler=null;
        Object.defineProperty(node,'onaudioprocess',{get(){return handler},set(fn){
          handler=fn;
          descriptor.set.call(node,function(event){
            fn.call(node,event);
            quanta.calls++;
            const data=event.outputBuffer.getChannelData(0);
            let peak=0;for(const value of data)peak=Math.max(peak,Math.abs(value));
            quanta.peak=Math.max(quanta.peak,peak);if(peak>0.00001)quanta.nonzero++;
          });
        }});
        return node;
      };
    }
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) {
      if (this.buffer && this.buffer.length > 1) {
        const data = this.buffer.getChannelData(0);
        let power = 0, peak = 0;
        for (let i = 0; i < data.length; i++) {
          power += data[i] * data[i]; peak = Math.max(peak, Math.abs(data[i]));
        }
        starts.push({at: performance.now(), duration: this.buffer.duration,
          loop: this.loop, rate: this.playbackRate.value, rms: Math.sqrt(power / data.length),
          peak, context: this.context.state});
        if (starts.length > 160) starts.shift();
      }
      return start.apply(this, args);
    };
  }
  function prime() {
    if (!NativeContext) return;
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
      if (!contexts.length) {
        prepared = track(new NativeContext());
        const source = prepared.createBufferSource();
        source.buffer = prepared.createBuffer(1, 1, prepared.sampleRate);
        source.connect(prepared.destination);
        source.start();
      }
      if (isAppleTouch && !navigator.audioSession && !legacyAudio) {
        legacyAudio = new Audio('audio-unlock.wav');
        legacyAudio.loop = true;
        legacyAudio.setAttribute('playsinline', '');
      }
      if (legacyAudio && legacyAudio.paused) legacyAudio.play().catch(report);
      resume();
    } catch (error) { report(error); }
  }
  function resume() {
    contexts.forEach(context => {
      if (context.state !== 'running' && context.state !== 'closed') {
        context.resume().then(update).catch(report);
      }
    });
    update();
  }
  function suspend() {
    contexts.forEach(context => {
      if (context.state === 'running') context.suspend().catch(report);
    });
    if (legacyAudio) legacyAudio.pause();
  }
  function update() {
    const button = document.getElementById('resume-audio');
    if (button) button.hidden = !window.outlastStarted || document.hidden ||
      !contexts.some(context => !['running', 'closed'].includes(context.state));
  }
  function snapshot() {
    return {states: contexts.map(context => context.state),
      sampleRates: contexts.map(context => context.sampleRate),
      session: navigator.audioSession?.type || null, errors: errors.slice(),
      starts: qa ? starts.slice() : undefined,
      graph: qa ? connections : undefined, quanta: qa ? {...quanta} : undefined,
      meters: qa ? [...meters].map(([context, meter]) => {
        const data = new Float32Array(meter.fftSize);
        meter.getFloatTimeDomainData(data);
        let sum = 0, peak = 0;
        for (const value of data) { sum += value * value; peak = Math.max(peak, Math.abs(value)); }
        return {state: context.state, rms: Math.sqrt(sum / data.length), peak};
      }) : undefined};
  }
  ['touchend', 'pointerup', 'click', 'keydown'].forEach(event => {
    document.addEventListener(event, () => { if (window.outlastStarted) prime(); }, true);
  });
  window.outlastAudio = {prime, resume, suspend, snapshot, update};
})();
