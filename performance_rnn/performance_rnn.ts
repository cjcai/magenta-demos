/* Copyright 2017 Google Inc. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/
import * as tf from '@tensorflow/tfjs-core';
import { KeyboardElement } from './keyboard_element';

// tslint:disable-next-line:no-require-imports
const Piano = require('tone-piano').Piano;

let lstmKernel1: tf.Tensor2D;
let lstmBias1: tf.Tensor1D;
let lstmKernel2: tf.Tensor2D;
let lstmBias2: tf.Tensor1D;
let lstmKernel3: tf.Tensor2D;
let lstmBias3: tf.Tensor1D;
let c: tf.Tensor2D[];
let h: tf.Tensor2D[];
let fcB: tf.Tensor1D;
let fcW: tf.Tensor2D;
const forgetBias = tf.scalar(1.0);
const activeNotes = new Map<number, number>();

// How many steps to generate per generateStep call.
// Generating more steps makes it less likely that we'll lag behind in note
// generation. Generating fewer steps makes it less likely that the browser UI
// thread will be starved for cycles.
const STEPS_PER_GENERATE_CALL = 10;
// How much time to try to generate ahead. More time means fewer buffer
// underruns, but also makes the lag from UI change to output larger.
const GENERATION_BUFFER_SECONDS = .5;
// If we're this far behind, reset currentTime time to piano.now().
const MAX_GENERATION_LAG_SECONDS = 1;
// If a note is held longer than this, release it.
const MAX_NOTE_DURATION_SECONDS = 3;

const NOTES_PER_OCTAVE = 12;
const DENSITY_BIN_RANGES = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0];
const PITCH_HISTOGRAM_SIZE = NOTES_PER_OCTAVE;

const RESET_RNN_FREQUENCY_MS = 30000;

let pitchHistogramEncoding: tf.Tensor1D;
let pitchHistogram: any = null;
let noteDensityEncoding: tf.Tensor1D;
let noteDensityIdx = 0;
let conditioned = true;

let recordingPreset = false;
let currPresetRecording: any = null;
let recordTimeTimeout: ReturnType<typeof setInterval> = null;


let currentPianoTimeSec = 0;
// When the piano roll starts in browser-time via performance.now().
let pianoStartTimestampMs = 0;

let currentVelocity = 100;

const MIN_MIDI_PITCH = 0;
const MAX_MIDI_PITCH = 127;
const VELOCITY_BINS = 32;
const MAX_SHIFT_STEPS = 100;
const STEPS_PER_SECOND = 100;

const MIDI_EVENT_ON = 0x90;
const MIDI_EVENT_OFF = 0x80;
const MIDI_NO_OUTPUT_DEVICES_FOUND_MESSAGE = 'No midi output devices found.';
const MIDI_NO_INPUT_DEVICES_FOUND_MESSAGE = 'No midi input devices found.';

const MID_IN_CHORD_RESET_THRESHOLD_MS = 1000;

// The unique id of the currently scheduled setTimeout loop.
let currentLoopId = 0;
let timeout: ReturnType<typeof setTimeout> = null;
let playing = true;

const EVENT_RANGES = [
  ['note_on', MIN_MIDI_PITCH, MAX_MIDI_PITCH],
  ['note_off', MIN_MIDI_PITCH, MAX_MIDI_PITCH],
  ['time_shift', 1, MAX_SHIFT_STEPS],
  ['velocity_change', 1, VELOCITY_BINS],
];

function calculateEventSize(): number {
  let eventOffset = 0;
  for (const eventRange of EVENT_RANGES) {
    const minValue = eventRange[1] as number;
    const maxValue = eventRange[2] as number;
    eventOffset += maxValue - minValue + 1;
  }
  return eventOffset;
}

const EVENT_SIZE = calculateEventSize();
const PRIMER_IDX = 355;  // shift 1s.
let lastSample = tf.scalar(PRIMER_IDX, 'int32');

const container = document.querySelector('#keyboard');
const keyboardInterface = new KeyboardElement(container);

const piano = new Piano({ velocities: 4 }).toMaster();

const SALAMANDER_URL = 'https://storage.googleapis.com/' +
  'download.magenta.tensorflow.org/demos/SalamanderPiano/';
const CHECKPOINT_URL = 'https://storage.googleapis.com/' +
  'download.magenta.tensorflow.org/models/performance_rnn/tfjs';

const isDeviceSupported = tf.ENV.get('WEBGL_VERSION') >= 1;

if (!isDeviceSupported) {
  document.querySelector('#status').innerHTML =
    'We do not yet support your device. Please try on a desktop ' +
    'computer with Chrome/Firefox, or an Android phone with WebGL support.';
} else {
  start();
}

let modelReady = false;

function start() {
  piano.load(SALAMANDER_URL)
    .then(() => {
      return fetch(`${CHECKPOINT_URL}/weights_manifest.json`)
        .then((response) => response.json())
        .then(
        (manifest: tf.WeightsManifestConfig) =>
          tf.loadWeights(manifest, CHECKPOINT_URL));
    })
    .then((vars: { [varName: string]: tf.Tensor }) => {
      document.querySelector('#status').classList.add('hidden');
      document.querySelector('#controls').classList.remove('hidden');
      document.querySelector('#keyboard').classList.remove('hidden');

      lstmKernel1 =
        vars['rnn/multi_rnn_cell/cell_0/basic_lstm_cell/kernel'] as
        tf.Tensor2D;
      lstmBias1 = vars['rnn/multi_rnn_cell/cell_0/basic_lstm_cell/bias'] as
        tf.Tensor1D;

      lstmKernel2 =
        vars['rnn/multi_rnn_cell/cell_1/basic_lstm_cell/kernel'] as
        tf.Tensor2D;
      lstmBias2 = vars['rnn/multi_rnn_cell/cell_1/basic_lstm_cell/bias'] as
        tf.Tensor1D;

      lstmKernel3 =
        vars['rnn/multi_rnn_cell/cell_2/basic_lstm_cell/kernel'] as
        tf.Tensor2D;
      lstmBias3 = vars['rnn/multi_rnn_cell/cell_2/basic_lstm_cell/bias'] as
        tf.Tensor1D;

      fcB = vars['fully_connected/biases'] as tf.Tensor1D;
      fcW = vars['fully_connected/weights'] as tf.Tensor2D;
      modelReady = true;
      resetRnn();
    });
}

function resetRnn() {
  c = [
    tf.zeros([1, lstmBias1.shape[0] / 4]),
    tf.zeros([1, lstmBias2.shape[0] / 4]),
    tf.zeros([1, lstmBias3.shape[0] / 4]),
  ];
  h = [
    tf.zeros([1, lstmBias1.shape[0] / 4]),
    tf.zeros([1, lstmBias2.shape[0] / 4]),
    tf.zeros([1, lstmBias3.shape[0] / 4]),
  ];
  if (lastSample != null) {
    lastSample.dispose();
  }
  lastSample = tf.scalar(PRIMER_IDX, 'int32');
  currentPianoTimeSec = piano.now();
  pianoStartTimestampMs = performance.now() - currentPianoTimeSec * 1000;
  currentLoopId++;

  updateConditioningParams();
  if (playing) {
    generateStep(currentLoopId);
  }

}

window.addEventListener('resize', resize);

function resize() {
  keyboardInterface.resize();
}

resize();

const densityControl =
  document.getElementById('note-density') as HTMLInputElement;
const densityDisplay = document.getElementById('note-density-display');
const conditioningOffElem =
  document.getElementById('conditioning-off') as HTMLInputElement;
conditioningOffElem.onchange = disableConditioning;
const conditioningOnElem =
  document.getElementById('conditioning-on') as HTMLInputElement;
conditioningOnElem.onchange = enableConditioning;
setTimeout(() => enableConditioning());

const conditioningControlsElem =
  document.getElementById('conditioning-controls') as HTMLDivElement;

const gainSliderElement = document.getElementById('gain') as HTMLInputElement;
const gainDisplayElement =
  document.getElementById('gain-display') as HTMLSpanElement;
let globalGain = +gainSliderElement.value;
gainSliderElement.addEventListener('input', () => {
  updateConditioningParams()
  // updateGain(+gainSliderElement.value);
});

const notes = ['c', 'cs', 'd', 'ds', 'e', 'f', 'fs', 'g', 'gs', 'a', 'as', 'b'];

const pitchHistogramElements = notes.map(
  note => document.getElementById('pitch-' + note) as HTMLInputElement);
const histogramDisplayElements = notes.map(
  note => document.getElementById('hist-' + note) as HTMLDivElement);

let preset1 = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
let preset2 = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
let presets: { [key: string]: any } = {};

try {
  parseHash();
} catch (e) {
  // If we didn't successfully parse the hash, we can just use defaults.
  console.warn(e);
}

function parseHash() {
  if (!window.location.hash) {
    return;
  }
  const params = window.location.hash.substr(1).split('|');
  densityControl.value = params[0];
  const pitches = params[1].split(',');
  for (let i = 0; i < pitchHistogramElements.length; i++) {
    pitchHistogramElements[i].value = pitches[i];
  }
  const preset1Values = params[2].split(',');
  for (let i = 0; i < preset1.length; i++) {
    preset1[i] = parseInt(preset1Values[i], 10);
  }
  const preset2Values = params[3].split(',');
  for (let i = 0; i < preset2.length; i++) {
    preset2[i] = parseInt(preset2Values[i], 10);
  }
  if (params[4] === 'true') {
    enableConditioning();

  } else if (params[4] === 'false') {
    disableConditioning();
  }
}

function enableConditioning() {
  conditioned = true;
  conditioningOffElem.checked = false;
  conditioningOnElem.checked = true;

  conditioningControlsElem.classList.remove('inactive');
  conditioningControlsElem.classList.remove('midicondition');

  updateConditioningParams();
}
function disableConditioning() {
  conditioned = false;
  conditioningOffElem.checked = true;
  conditioningOnElem.checked = false;

  conditioningControlsElem.classList.add('inactive');
  conditioningControlsElem.classList.remove('midicondition');

  updateConditioningParams();
}

function updateGain(gain: number) {
  globalGain = gain;
  gainDisplayElement.innerText = globalGain.toString();
  gainSliderElement.value = globalGain.toString();
}

function updateNoteDensity(noteDensityIdx: number) {
  if (noteDensityEncoding != null) {
    noteDensityEncoding.dispose();
    noteDensityEncoding = null;
  }
  let noteDensity = DENSITY_BIN_RANGES[noteDensityIdx];
  densityDisplay.innerHTML = noteDensity.toString();
  densityControl.value = noteDensityIdx.toString();
  noteDensityEncoding =
    tf.oneHot(
      tf.tensor1d([noteDensityIdx + 1], 'int32'),
      DENSITY_BIN_RANGES.length + 1).as1D();
}

function updateConditioningParams(eventName?: string) {
  let evtName = eventName;
  pitchHistogram = pitchHistogramElements.map(e => {
    return parseInt(e.value, 10) || 0;
  });
  updateDisplayHistogram(pitchHistogram);

  if (+gainSliderElement.value - globalGain != 0) { evtName = "volume " + ((+gainSliderElement.value - globalGain > 0) ? "increased" : "decreased") }
  globalGain = +gainSliderElement.value;
  updateGain(+gainSliderElement.value);

  if (+densityControl.value - noteDensityIdx != 0) { evtName = "density " + ((+densityControl.value - noteDensityIdx > 0) ? "increased" : "decreased") }
  noteDensityIdx = parseInt(densityControl.value, 10) || 0;
  updateNoteDensity(noteDensityIdx);

  window.location.assign(
    '#' + densityControl.value + '|' + pitchHistogram.join(',') + '|' +
    preset1.join(',') + '|' + preset2.join(',') + '|' +
    (conditioned ? 'true' : 'false'));


  if (pitchHistogramEncoding != null) {
    pitchHistogramEncoding.dispose();
    pitchHistogramEncoding = null;
  }
  const buffer = tf.buffer<tf.Rank.R1>([PITCH_HISTOGRAM_SIZE], 'float32');
  const pitchHistogramTotal = pitchHistogram.reduce((prev: any, val: any) => {
    return prev + val;
  });
  for (let i = 0; i < PITCH_HISTOGRAM_SIZE; i++) {
    buffer.set(pitchHistogram[i] / pitchHistogramTotal, i);
  }
  pitchHistogramEncoding = buffer.toTensor();

  if (recordingPreset) {
    updatePresetRecording(evtName);
  }
}

document.getElementById('note-density').oninput = () => { updateConditioningParams() };
pitchHistogramElements.forEach(e => {
  e.oninput = () => { updateConditioningParams(e.value) };
});
updateConditioningParams();

function updatePitchHistogram(newHist: number[], eventName?: string) {
  let allZero = true;
  for (let i = 0; i < newHist.length; i++) {
    allZero = allZero && newHist[i] === 0;
  }
  if (allZero) {
    newHist = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  }
  for (let i = 0; i < newHist.length; i++) {
    pitchHistogramElements[i].value = newHist[i].toString();
  }

  updateConditioningParams(eventName);
}
function updateDisplayHistogram(hist: number[]) {
  let sum = 0;
  for (let i = 0; i < hist.length; i++) {
    sum += hist[i];
  }

  for (let i = 0; i < hist.length; i++) {
    histogramDisplayElements[i].style.height =
      (100 * (hist[i] / sum)).toString() + 'px';
  }
}

document.getElementById("key").onchange = () => {
  const key = (document.getElementById("key") as HTMLSelectElement).value;
  console.log("KEY", key);
  const offset = keyOffset[key];
  let histogram = (key.indexOf("Major") > -1) ? majorHistogram : minorHistogram;
  let shiftedHistogram = histogram.slice(histogram.length - offset, histogram.length).concat(histogram.slice(0, histogram.length - offset));
  updatePitchHistogram(shiftedHistogram, key);
}

document.getElementById("chord").onchange = () => {
  const chord = (document.getElementById("chord") as HTMLSelectElement).value.substring(0);
  const key = (document.getElementById("key") as HTMLSelectElement).value;
  const offset = keyOffset[key];
  let histogram = (key.indexOf("Major") > -1) ? majorHistogram : minorHistogram;
  const chordOffset = parseInt(chord);
  let indices = [chordOffset, // one
    (chordOffset + 2) > 7 ? (chordOffset + 2) % 7 : (chordOffset + 2), // three
    (chordOffset + 4) > 7 ? (chordOffset + 4) % 7 : (chordOffset + 4)]; // five

  let chordHistogram = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let numNotesSeen = 0;
  for (let i = 0; i < histogram.length; i++) {
    if (histogram[i] > 0) {
      numNotesSeen += 1;
      if (indices.indexOf(numNotesSeen) > -1) {
        chordHistogram[i] = 1;
      }
    }
  }
  let shiftedHistogram = chordHistogram.slice(chordHistogram.length - offset, chordHistogram.length).concat(chordHistogram.slice(0, chordHistogram.length - offset));

  updatePitchHistogram(shiftedHistogram, chord + " chord");
}

const majorHistogram = [2, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];
const minorHistogram = [2, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1];

const keyOffset: { [id: string]: number } = {
  "C Major": 0,
  "c minor": 0,
  "C# Major": 1,
  "c# minor": 1,
  "D Major": 2,
  "d minor": 2,
  "D# Major": 3,
  "d# minor": 3,
  "E Major": 4,
  "e minor": 4,
  "F Major": 5,
  "f minor": 5,
  "F# Major": 6,
  "f# minor": 6,
  "G Major": 7,
  "g minor": 7,
  "G# Major": 8,
  "g# minor": 8,
  "A Major": 9,
  "a minor": 9,
  "A# Major": 10,
  "a# minor": 10,
  "B Major": 11,
  "b minor": 11
}


/*document.getElementById('c-major').onclick = () => {
  updatePitchHistogram([2, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1]);
};

document.getElementById('f-major').onclick = () => {
  updatePitchHistogram([1, 0, 1, 0, 1, 2, 0, 1, 0, 1, 1, 0]);
};

document.getElementById('d-minor').onclick = () => {
  updatePitchHistogram([1, 0, 2, 0, 1, 1, 0, 1, 0, 1, 1, 0]);
};*/

document.getElementById('whole-tone').onclick = () => {
  updatePitchHistogram([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], "whole-tone");
};

document.getElementById('pentatonic').onclick = () => {
  updatePitchHistogram([0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0], "pentatonic");
};

document.getElementById('reset-rnn').onclick = () => {
  resetRnn();
};

document.getElementById('playcontrol').onclick = () => {
  const elem = document.getElementById('playcontrol');
  if (elem.getAttribute("value") == "pause") {
    clearTimeout(timeout);
    playing = false;
    elem.setAttribute("value", "play");
  } else {
    playing = true;
    elem.setAttribute("value", "pause");
    generateStep(currentLoopId);
  }
};


/*document.getElementById('preset-1').onclick = () => {
  updatePitchHistogram(preset1);
  console.log('preset-1', presets['test']);
  updateNoteDensity(presets['test']['noteDensityIdx']);
  updateGain(presets['test']['gain']);
};*/

/*document.getElementById('preset-2').onclick = () => {
  updatePitchHistogram(preset2);
};*/

document.getElementById('save-preset').onclick = () => {
  updateConditioningParams();

  const preset = { 'pitchHistogram': pitchHistogram, 'noteDensityIdx': noteDensityIdx, 'gain': globalGain };
  savePreset(preset);
};

function savePreset(preset: any) {
  const numPresets = Object.keys(presets).length;
  const presetName = 'preset ' + (numPresets + 1);
  presets[presetName] = preset;
  addPresetButton(presetName);
}

document.getElementById('record-preset').onclick = () => {
  clearEvents();
  const recordElem = document.getElementById('record-preset');

  let recordTimeElem = document.getElementById('record-time');
  if (recordElem.getAttribute("value") == "Record Preset") {
    recordElem.setAttribute("value", "Stop Recording");
    recordElem.classList.add("recording");
    recordElem.classList.remove("not-recording");
    updateConditioningParams();
    recordingPreset = true;
    currPresetRecording = [];
    recordTimeElem.innerHTML = 'recording changes: Time 0';
    recordTimeTimeout = setInterval(() => {
      recordTimeElem.innerHTML = 'recording changes: Time ' + (parseInt(recordTimeElem.innerHTML.split("Time ")[1]) + 1).toString();
    }, 1000);
  } else {
    recordElem.setAttribute("value", "Record Preset");
    recordElem.classList.remove("recording");
    recordElem.classList.add("not-recording");
    recordTimeElem.innerHTML = '';
    recordingPreset = false;
    if (currPresetRecording.length > 0) { // blank recording
      savePreset(currPresetRecording);
    }
    clearInterval(recordTimeTimeout);
  }
};

function updatePresetRecording(eventName?: string) {
  if (eventName == undefined) {
    return;
  }
  let lastEvent = currPresetRecording.length == 0 ? "" : currPresetRecording[currPresetRecording.length - 1]['eventName'];
  let time = document.getElementById('record-time').innerHTML;
  time = time.split("Time ")[1];
  let newEvent = { 'time': time, 'eventName': eventName, 'pitchHistogram': pitchHistogram, 'noteDensityIdx': noteDensityIdx, 'gain': globalGain };
  currPresetRecording.push(newEvent);
  if (eventName != lastEvent) {
    showEvent(newEvent);
  }
}

function showEvent(event: any) {
  let eventsElem = document.getElementById('record-events');
  let evtElem = document.createElement("span");
  evtElem.setAttribute("class", "record-event");
  evtElem.innerHTML = 'Time ' + event['time'] + ": " + event['eventName'];
  eventsElem.appendChild(evtElem);
}

function clearEvents() {
  document.getElementById('record-events').innerHTML = '';
}

function addPresetButton(name: string) {
  let presetContainer: HTMLElement = document.createElement("div");
  presetContainer.setAttribute("class", "presetcontainer");
  let preset: HTMLElement = document.createElement("input");
  preset.setAttribute("type", "button");
  preset.setAttribute("value", name);
  preset.setAttribute("id", name);
  preset.setAttribute("class", "ui-condition preset");

  let presetTextfield: HTMLInputElement = document.createElement("input");
  presetTextfield.setAttribute("type", "text");
  presetTextfield.setAttribute("size", "20");
  presetTextfield.setAttribute("placeholder", "name it (e.g. peaceful)");

  let thisPreset = presets[name];
  presetContainer.appendChild(preset);
  presetContainer.appendChild(presetTextfield);
  document.getElementById("presets").appendChild(presetContainer);

  let presetTimeout: ReturnType<typeof setTimeout> = null;
  let ticks = 0;

  for (var i = 0; i < thisPreset.length; i++) {
    console.log(thisPreset[i]['eventName']);
  }
  function playRecordedPreset() {
    if (ticks == 0) {
      clearEvents();
    }
    if (ticks > thisPreset[thisPreset.length - 1]['time']) {
      ticks = 0;
      clearTimeout(presetTimeout);
    } else {
      for (var i = 0; i < thisPreset.length; i++) {
        let presetProperties = thisPreset[i];
        if (ticks == presetProperties['time']) {
          updatePitchHistogram(presetProperties['pitchHistogram']);
          updateNoteDensity(presetProperties['noteDensityIdx']);
          updateGain(presetProperties['gain']);
          showEvent(presetProperties);
        } else if (parseInt(presetProperties['time']) > ticks) {
          break;
        }
      }

      ticks += 1;
      setTimeout(playRecordedPreset, 1000);
    }
  }

  function playPreset() {
    clearEvents();
    updatePitchHistogram(thisPreset['pitchHistogram']);
    updateNoteDensity(thisPreset['noteDensityIdx']);
    updateGain(thisPreset['gain']);
  }

  preset.onclick = () => {
    const presetElems = document.getElementsByClassName("preset");
    for (let i = 0; i < presetElems.length; i++) {
      presetElems[i].classList.remove("presetSelected")
    }

    preset.classList.add("presetSelected");
    Array.isArray(thisPreset) ? playRecordedPreset() : playPreset();
  };

  presetTextfield.addEventListener("keyup", (e) => {
    if (e.keyCode == 13) {

      let newName = presetTextfield.value;
      preset.setAttribute("value", newName);
      preset.setAttribute("id", newName);
      preset.setAttribute("placeholer", "");
      presetTextfield.value = "";
      // console.log(presetTextfield.getAttribute("value"), presetTextfield.value);
    }
  });
}

/*document.getElementById('save-2').onclick = () => {
  preset2 = pitchHistogramElements.map((e) => {
    return parseInt(e.value, 10) || 0;
  });
  updateConditioningParams();
};*/

function getConditioning(): tf.Tensor1D {
  /* let noteDensityEncoding =
     tf.oneHot(
       tf.tensor1d([noteDensityIdx + 1], 'int32'),
       DENSITY_BIN_RANGES.length + 1).as1D();
 */
  return tf.tidy(() => {
    if (!conditioned) {
      // TODO(nsthorat): figure out why we have to cast these shapes to numbers.
      // The linter is complaining, though VSCode can infer the types.
      const size = 1 + (noteDensityEncoding.shape[0] as number) +
        (pitchHistogramEncoding.shape[0] as number);
      const conditioning: tf.Tensor1D =
        tf.oneHot(tf.tensor1d([0], 'int32'), size).as1D();
      return conditioning;
    } else {
      const axis = 0;
      const conditioningValues =
        noteDensityEncoding.concat(pitchHistogramEncoding, axis);
      return tf.tensor1d([0], 'int32').concat(conditioningValues, axis);
    }
  });
}

async function generateStep(loopId: number) {
  if (loopId < currentLoopId) {
    // Was part of an outdated generateStep() scheduled via setTimeout.
    return;
  }

  const lstm1 = (data: tf.Tensor2D, c: tf.Tensor2D, h: tf.Tensor2D) =>
    tf.basicLSTMCell(forgetBias, lstmKernel1, lstmBias1, data, c, h);
  const lstm2 = (data: tf.Tensor2D, c: tf.Tensor2D, h: tf.Tensor2D) =>
    tf.basicLSTMCell(forgetBias, lstmKernel2, lstmBias2, data, c, h);
  const lstm3 = (data: tf.Tensor2D, c: tf.Tensor2D, h: tf.Tensor2D) =>
    tf.basicLSTMCell(forgetBias, lstmKernel3, lstmBias3, data, c, h);

  let outputs: tf.Scalar[] = [];
  [c, h, outputs] = tf.tidy(() => {
    // Generate some notes.
    const innerOuts: tf.Scalar[] = [];
    for (let i = 0; i < STEPS_PER_GENERATE_CALL; i++) {
      // Use last sampled output as the next input.
      const eventInput = tf.oneHot(
        lastSample.as1D(), EVENT_SIZE).as1D();
      // Dispose the last sample from the previous generate call, since we
      // kept it.
      if (i === 0) {
        lastSample.dispose();
      }
      const conditioning = getConditioning();
      const axis = 0;
      const input = conditioning.concat(eventInput, axis).toFloat();
      const output =
        tf.multiRNNCell([lstm1, lstm2, lstm3], input.as2D(1, -1), c, h);
      c.forEach(c => c.dispose());
      h.forEach(h => h.dispose());
      c = output[0];
      h = output[1];

      const outputH = h[2];
      const logits = outputH.matMul(fcW).add(fcB);

      const sampledOutput = tf.multinomial(logits.as1D(), 1).asScalar();

      innerOuts.push(sampledOutput);
      lastSample = sampledOutput;
    }
    return [c, h, innerOuts] as [tf.Tensor2D[], tf.Tensor2D[], tf.Scalar[]];
  });

  for (let i = 0; i < outputs.length; i++) {
    playOutput(outputs[i].dataSync()[0]);
  }

  if (piano.now() - currentPianoTimeSec > MAX_GENERATION_LAG_SECONDS) {
    console.warn(
      `Generation is ${piano.now() - currentPianoTimeSec} seconds behind, ` +
      `which is over ${MAX_NOTE_DURATION_SECONDS}. Resetting time!`);
    currentPianoTimeSec = piano.now();
  }
  const delta = Math.max(
    0, currentPianoTimeSec - piano.now() - GENERATION_BUFFER_SECONDS);

  if (playing) {
    setTimeout(() => generateStep(loopId), delta * 1000);
  }

}

let midi;
// tslint:disable-next-line:no-any
let activeMidiOutputDevice: any = null;
// tslint:disable-next-line:no-any
let activeMidiInputDevice: any = null;
(async () => {
  const midiOutDropdownContainer =
    document.getElementById('midi-out-container');
  const midiInDropdownContainer = document.getElementById('midi-in-container');
  try {
    // tslint:disable-next-line:no-any
    const navigator: any = window.navigator;
    midi = await navigator.requestMIDIAccess();

    const midiOutDropdown =
      document.getElementById('midi-out') as HTMLSelectElement;
    const midiInDropdown =
      document.getElementById('midi-in') as HTMLSelectElement;

    let outputDeviceCount = 0;
    // tslint:disable-next-line:no-any
    const midiOutputDevices: any[] = [];
    // tslint:disable-next-line:no-any
    midi.outputs.forEach((output: any) => {
      console.log(`
          Output midi device [type: '${output.type}']
          id: ${output.id}
          manufacturer: ${output.manufacturer}
          name:${output.name}
          version: ${output.version}`);
      midiOutputDevices.push(output);

      const option = document.createElement('option');
      option.innerText = output.name;
      midiOutDropdown.appendChild(option);
      outputDeviceCount++;
    });

    midiOutDropdown.addEventListener('change', () => {
      activeMidiOutputDevice =
        midiOutputDevices[midiOutDropdown.selectedIndex - 1];
    });

    if (outputDeviceCount === 0) {
      midiOutDropdownContainer.innerText = MIDI_NO_OUTPUT_DEVICES_FOUND_MESSAGE;
    }

    let inputDeviceCount = 0;
    // tslint:disable-next-line:no-any
    const midiInputDevices: any[] = [];
    // tslint:disable-next-line:no-any
    midi.inputs.forEach((input: any) => {
      console.log(`
        Input midi device [type: '${input.type}']
        id: ${input.id}
        manufacturer: ${input.manufacturer}
        name:${input.name}
        version: ${input.version}`);
      midiInputDevices.push(input);

      const option = document.createElement('option');
      option.innerText = input.name;
      midiInDropdown.appendChild(option);
      inputDeviceCount++;
    });

    // tslint:disable-next-line:no-any
    const setActiveMidiInputDevice = (device: any) => {
      if (activeMidiInputDevice != null) {
        activeMidiInputDevice.onmidimessage = () => { };
      }
      activeMidiInputDevice = device;
      // tslint:disable-next-line:no-any
      device.onmidimessage = (event: any) => {
        const data = event.data;
        const type = data[0] & 0xf0;
        const note = data[1];
        const velocity = data[2];
        if (type === 144) {
          midiInNoteOn(note, velocity);
        }
      };
    };
    midiInDropdown.addEventListener('change', () => {
      setActiveMidiInputDevice(
        midiInputDevices[midiInDropdown.selectedIndex - 1]);
    });
    if (inputDeviceCount === 0) {
      midiInDropdownContainer.innerText = MIDI_NO_INPUT_DEVICES_FOUND_MESSAGE;
    }
  } catch (e) {
    midiOutDropdownContainer.innerText = MIDI_NO_OUTPUT_DEVICES_FOUND_MESSAGE;

    midi = null;
  }
})();

/**
 * Handle midi input.
 */
const CONDITIONING_OFF_TIME_MS = 30000;
let lastNotePressedTime = performance.now();
let midiInPitchHistogram = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
function midiInNoteOn(midiNote: number, velocity: number) {
  const now = performance.now();
  if (now - lastNotePressedTime > MID_IN_CHORD_RESET_THRESHOLD_MS) {
    midiInPitchHistogram = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    resetRnn();
  }
  lastNotePressedTime = now;

  // Turn on conditioning when a note is pressed/
  if (!conditioned) {
    resetRnn();
    enableConditioning();
  }

  // Turn off conditioning after 30 seconds unless other notes have been played.
  setTimeout(() => {
    if (performance.now() - lastNotePressedTime > CONDITIONING_OFF_TIME_MS) {
      disableConditioning();
      resetRnn();
    }
  }, CONDITIONING_OFF_TIME_MS);

  const note = midiNote % 12;
  midiInPitchHistogram[note]++;

  updateMidiInConditioning();
}

function updateMidiInConditioning() {
  updatePitchHistogram(midiInPitchHistogram);
}

/**
 * Decode the output index and play it on the piano and keyboardInterface.
 */
function playOutput(index: number) {
  let offset = 0;
  for (const eventRange of EVENT_RANGES) {
    const eventType = eventRange[0] as string;
    const minValue = eventRange[1] as number;
    const maxValue = eventRange[2] as number;
    if (offset <= index && index <= offset + maxValue - minValue) {
      if (eventType === 'note_on') {
        const noteNum = index - offset;
        setTimeout(() => {
          keyboardInterface.keyDown(noteNum);
          setTimeout(() => {
            keyboardInterface.keyUp(noteNum);
          }, 100);
        }, (currentPianoTimeSec - piano.now()) * 1000);
        activeNotes.set(noteNum, currentPianoTimeSec);

        if (activeMidiOutputDevice != null) {
          try {
            activeMidiOutputDevice.send(
              [
                MIDI_EVENT_ON, noteNum,
                Math.min(Math.floor(currentVelocity * globalGain), 127)
              ],
              Math.floor(1000 * currentPianoTimeSec) - pianoStartTimestampMs);
          } catch (e) {
            console.log(
              'Error sending midi note on event to midi output device:');
            console.log(e);
          }
        }

        return piano.keyDown(
          noteNum, currentPianoTimeSec, currentVelocity * globalGain / 100);
      } else if (eventType === 'note_off') {
        const noteNum = index - offset;

        const activeNoteEndTimeSec = activeNotes.get(noteNum);
        // If the note off event is generated for a note that hasn't been
        // pressed, just ignore it.
        if (activeNoteEndTimeSec == null) {
          return;
        }
        const timeSec =
          Math.max(currentPianoTimeSec, activeNoteEndTimeSec + .5);

        if (activeMidiOutputDevice != null) {
          activeMidiOutputDevice.send(
            [
              MIDI_EVENT_OFF, noteNum,
              Math.min(Math.floor(currentVelocity * globalGain), 127)
            ],
            Math.floor(timeSec * 1000) - pianoStartTimestampMs);
        }
        piano.keyUp(noteNum, timeSec);
        activeNotes.delete(noteNum);
        return;
      } else if (eventType === 'time_shift') {
        currentPianoTimeSec += (index - offset + 1) / STEPS_PER_SECOND;
        activeNotes.forEach((timeSec, noteNum) => {
          if (currentPianoTimeSec - timeSec > MAX_NOTE_DURATION_SECONDS) {
            console.info(
              `Note ${noteNum} has been active for ${
              currentPianoTimeSec - timeSec}, ` +
              `seconds which is over ${MAX_NOTE_DURATION_SECONDS}, will ` +
              `release.`);
            if (activeMidiOutputDevice != null) {
              activeMidiOutputDevice.send([
                MIDI_EVENT_OFF, noteNum,
                Math.min(Math.floor(currentVelocity * globalGain), 127)
              ]);
            }
            piano.keyUp(noteNum, currentPianoTimeSec);
            activeNotes.delete(noteNum);
          }
        });
        return currentPianoTimeSec;
      } else if (eventType === 'velocity_change') {
        currentVelocity = (index - offset + 1) * Math.ceil(127 / VELOCITY_BINS);
        currentVelocity = currentVelocity / 127;
        return currentVelocity;
      } else {
        throw new Error('Could not decode eventType: ' + eventType);
      }
    }
    offset += maxValue - minValue + 1;
  }
  throw new Error(`Could not decode index: ${index}`);
}

// Reset the RNN repeatedly so it doesn't trail off into incoherent musical
// babble.
const resettingText = document.getElementById('resettingText');
function resetRnnRepeatedly() {
  if (modelReady) {
    resetRnn();
    resettingText.style.opacity = '100';
  }

  setTimeout(() => {
    resettingText.style.opacity = '0';
  }, 1000);
  setTimeout(resetRnnRepeatedly, RESET_RNN_FREQUENCY_MS);
}
setTimeout(resetRnnRepeatedly, RESET_RNN_FREQUENCY_MS);
