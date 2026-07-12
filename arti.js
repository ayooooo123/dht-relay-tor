const Stream = require('.')
const { createArtiEntry } = require('./lib/arti-entry')

module.exports = createArtiEntry({
  loadArti: () => require('bare-arti'),
  Stream
})
