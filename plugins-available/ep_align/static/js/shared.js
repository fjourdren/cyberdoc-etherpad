'use strict';

const _ = require('ep_etherpad-lite/static/js/underscore');

const tags = ['left', 'center', 'justify', 'right'];

exports.collectContentPre = (hookName, context, cb) => {
  const tname = context.tname;
  const state = context.state;
  const lineAttributes = state.lineAttributes;
  const tagIndex = _.indexOf(tags, tname);
  if (tname === 'div' || tname === 'p') {
    delete lineAttributes.align;
  }
  if (tagIndex >= 0) {
    lineAttributes.align = tags[tagIndex];
  }
  return cb();
};

// I don't even know when this is run..
exports.collectContentPost = (hookName, context, cb) => {
  const tname = context.tname;
  const state = context.state;
  const lineAttributes = state.lineAttributes;
  const tagIndex = _.indexOf(tags, tname);
  if (tagIndex >= 0) {
    delete lineAttributes.align;
  }
  return cb();
};
