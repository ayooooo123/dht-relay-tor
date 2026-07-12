require('./socks5')
require('./relay')
require('./arti')

if (process.env.DHT_RELAY_TOR_TEST_TOR === '1') require('./tor')
