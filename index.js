require('dotenv').config();

const cluster = require('cluster');
const http = require('http');
const os = require('os');
const numCPUs = process.env.CLUSTERMASTER_NUM_CPUS || 2; //require('os').cpus().length;
const redis = require('redis');

const namespace = process.env.CLUSTERMASTER_NAMESPACE || 'cluster-exp:';

var debug = require('debug')(namespace);

var isClusterMaster = false;
var client = null;
var key = 'cluster-master';
var me = `${os.hostname()}:${process.pid}`;
var registration = `${key}:${me}`;
var channel = `${namespace}${registration}`;

var registerClusterMaster = function() {
  debug('Taking over as cluster master');
  isClusterMaster = true;
  client.set(key, me);
  client.del(registration);
};

var registerMaster = function() {
  client.set(registration, me);
  client.on("message", (chan, msg) => {
    var duplicate = client.duplicate();
    client.unsubscribe();
    client.quit();
    client = duplicate;
    registerClusterMaster();
  });
  client.subscribe(channel);
};

if (cluster.isMaster) {
  debug(`Master ${process.pid} is running`);

  client = redis.createClient({ prefix: namespace});

  client.get(key, (err, value) => {
    if (err) throw(err)

    if(!value){
      registerClusterMaster();
    } else {
      registerMaster();
    }
  });

  // Fork workers.
  for (let i = 0; i < numCPUs; i++) {
    var worker = cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    debug(`worker ${worker.process.pid} died`);
  });

} else {
  // Workers can share any TCP connection
  // In this case it is an HTTP server
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end('hello world\n');
  }).listen(process.env.PORT || 8000);

  debug(`Worker ${process.pid} started`);
}

var gracefulShutdown = function() {
    var node = cluster.isMaster ? 'Master' : 'Worker';
    debug(`${node} got SIGINT message`);

    if(cluster.isMaster){

      if(!isClusterMaster){
        client.del(registration, (err) => {
          process.exit();
        });
      } else {
        debug('Running ClusterMaster Shutdown');
        client.del(key, (err) => {
          if(err) throw(err);

          isClusterMaster = false;

          // this is where we promote the new master
          client.randomkey(function (err, newmaster) {
            if(err) throw(err)

            if(newmaster){
              client.publish(newmaster, 'promote');
            } else {
              debug('No more masters in cluster. Exit');
            }

            process.exit();
          });
        });

      }

    } else {
      process.exit();
    }
};

process.on('SIGINT', gracefulShutdown);
