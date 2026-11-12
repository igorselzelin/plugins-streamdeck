// SYNK soundboard controls. One process hosts every action; each feature file
// registers its handlers by full action UUID, and all of them share the single
// SYNK connection in runtime.js.
require('./features/sounds');
require('./features/controls');
require('./features/volume');
