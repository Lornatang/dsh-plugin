const Module = require('node:module')
const original = Module._load
Module._load = function (request, parent, isMain) {
  if (request.startsWith('@koromix/koffi-win32-')) throw new Error('simulated unavailable native support')
  return original.call(this, request, parent, isMain)
}
