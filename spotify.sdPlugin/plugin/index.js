// One process hosts every Spotify action; each feature registers its own handlers by action UUID.
require('./features/nowplaying');
require('./features/volume');
require('./features/seek');
require('./features/shuffle');
require('./features/queue');
