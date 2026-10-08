'use strict';
// Vercel serverless entry point — the whole Express app runs inside one function.
// Static files in /public are served by Vercel's CDN; everything else is rewritten here (see vercel.json).
module.exports = require('../server.js');
