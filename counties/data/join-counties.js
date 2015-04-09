var fs = require('fs');
var tito = require('tito');
var async = require('async');
var topojson = require('topojson');
var d3 = require('d3');
var util = require('./util');
var assert = require('assert');
var streamify = require('stream-array');

var read = util.readData;
var map = util.map;
var get = util.getter;

var TOPOLOGY_FILENAME = 'us-topology.json';
var REVENUES_FILENAME = 'county-revenues.tsv';

async.parallel({
  revenues: readRevenues,
  states: readStates,
  counties: readCounties
}, function(error, data) {
  if (error) return console.error('error:', error);

  var revenues = data.revenues;
  var states = data.states;
  var topology = data.counties;

  var statesByAbbr = map(states, 'abbr', true);

  // turn them into GeoJSON features
  var counties = topology.objects.counties.geometries;
  var countyFeatures = topojson.feature(topology, topology.objects.counties).features;

  // group counties by state to infer states
  var countiesByState = d3.nest()
    .key(function(d) {
      return d.properties.state;
    })
    .entries(counties);

  // American Samoa, Puerto Rico, Guam and Virgin Islands
  var territories = d3.set(['AS', 'PR', 'GU', 'VI']);

  var stateFeatures = countiesByState
    // filter out territories
    .filter(function(d) {
      return !territories.has(d.key);
    })
    // merge counties into states
    .map(function(d) {
      var abbr = d.key;
      var geom = topojson.merge(topology, d.values);
      return {
        id: abbr,
        properties: statesByAbbr[abbr],
        geometry: geom
      };
    });

  assert.equal(stateFeatures.length, 51);

  // fix the FIPS ids, because some numbers lack the 0 prefix
  countyFeatures.forEach(function(d) {
    d.id = d.properties.FIPS;
  });

  // fix the revenue FIPS codes
  var revenuesByState = map(revenues, 'St');
  var parsed = [];
  for (var abbr in revenuesByState) {
    revenuesByState[abbr].forEach(function(d) {
      var code = d['County Code'];
      var state = statesByAbbr[d.St];
      parsed.push({
        year: d.CY,
        commodity: d.Commodity,
        type: d['Revenue Type'],
        revenue: util.parseDollars(d['Royalty/Revenue']),
        state: state.name,
        county: d.County,
        FIPS: state.FIPS + code.substr(2)
      });
    });
  }

  var index = d3.nest()
    .key(get('FIPS'))
    .key(get('year')) // year
    .key(get('commodity'))
    .map(parsed);

  countyFeatures = countyFeatures.filter(function(d) {
    return d.id in index;
  });

  var out = topojson.topology({
    counties: {
      type: 'FeatureCollection',
      features: countyFeatures
    },
    states: {
      type: 'FeatureCollection',
      features: stateFeatures
    }
  }, {
    'verbose': true,
    'coordinate-system': 'spherical',
    'stitch-poles': true,
    // preserve all properties
    'property-transform': function(d) {
      return d.properties;
    }
  });

  var c = out.objects.counties.geometries;
  assert.ok(c[0].type, 'no type for county geometry' + JSON.stringify(c[0]));

  console.warn('writing topology to:', TOPOLOGY_FILENAME);
  fs.createWriteStream(TOPOLOGY_FILENAME)
    .write(JSON.stringify(out));

  console.warn('writing county revenues to:', REVENUES_FILENAME);
  streamify(parsed)
    .pipe(tito.formats.createWriteStream('tsv'))
    .pipe(fs.createWriteStream(REVENUES_FILENAME));
});

function readRevenues(done) {
  return read(
    'input/county-revenues.tsv',
    tito.formats.createReadStream('tsv'),
    done
  );
}

function readStates(done) {
  return read(
    'input/states.csv',
    tito.formats.createReadStream('csv'),
    done
  );
}

function readCounties(done) {
  return done(null, require('./geo/us-counties.json'));
}

function rename(obj, src, dest) {
  obj[dest] = obj[src];
  delete obj[src];
}