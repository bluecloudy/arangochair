'use strict';

const axios = require('axios')

const EventEmitter = require('events');

const mapTextToType = {
  'insert/update': '2300',
  'delete': '2302'
};
const mapTypeToText = {
  '2300': 'insert/update',
  '2302': 'delete'
};

class ArangoChair extends EventEmitter {
  constructor({ host, port, database, username, password }) {
    super();
    this.username = username
    this.password = password

    axios.defaults.baseURL = `${host}:${port}`
    this.axios = axios

    this._loggerStatePath = `/_db/${database}/_api/replication/logger-state`;
    this._loggerFollowPath = `/_db/${database}/_api/replication/logger-follow`;

    this.collectionsMap = new Map();
    this._stopped = false;
  }

  async start() {
    this._stopped = false;
    await this._startLoggerState();
  }

  stop() {
    this._stopped = true;
  }

  async _startLoggerState() {
    let { data: { jwt } } = await this.axios.post('/_open/auth', {
      username: this.username,
      password: this.password
    })
    this.axios.defaults.headers.common = { 'Authorization': `bearer ${jwt}` }

    let { status, headers, data: body } = await this.axios.get(this._loggerStatePath)
    if (200 !== status) {
      this.emit('error', new Error('E_LOGGERSTATE'), status, headers, data);
      this.stop();
      return;
    } // if

    let lastLogTick = body.state.lastLogTick;
    let lastTick = '';

    const ticktock = async () => {
      if (this._stopped) return;

      let { status, headers, data: body } = await this.axios.get(`${this._loggerFollowPath}?from=${lastLogTick}`)

      if (204 < status || 0 === status) {
        this.emit('error', new Error('E_LOGGERFOLLOW'), status, headers, body);
        this.stop();
        return;
      } // if

      if ('0' === headers['x-arango-replication-lastincluded']) {
        return setTimeout(ticktock, 500);
      } // if

      lastLogTick = headers['x-arango-replication-lastincluded'];

      if (typeof body === 'string') {
        const logs = body.split('\n');
        body = JSON.parse(logs[1]);
      }

      if (body.type == '2300' || body.type == '2302' || '2201' == body.type) {
        const handleEvent = () => {
          const colConf = this.collectionsMap.get(body.cname);
          if (undefined === colConf) return;
          this.emit(body.cname, JSON.stringify(body.data), mapTypeToText[body.type]);
        }
        if (lastTick != body.tick) {
          handleEvent();
        }
        lastTick = body.tick;
      }

      await ticktock();
    }

    await ticktock();
  }

  subscribe(confs) {
    if ('string' === typeof confs) confs = { collection: confs };
    if (!Array.isArray(confs)) confs = [confs];

    for (const conf of confs) {
      let colConfMap = undefined;
      if (this.collectionsMap.has(conf.collection)) {
        colConfMap = this.collectionsMap.get(conf.collection);
      } else {
        colConfMap = new Map([['events', new Set()], ['keys', new Set()]]);
        this.collectionsMap.set(conf.collection, colConfMap);
      }

      if (conf.events) {
        for (const event of conf.events) {
          colConfMap.get('events').add(mapTextToType[event]);
        } // for
      } // if
      if (conf.keys) {
        for (const key of conf.keys) {
          colConfMap.get('keys').add(key);
        } // for
      } // if
    } // for
  } // subscribe()

  unsubscribe(confs) {
    if ('string' === typeof confs) confs = { collection: confs };
    if (!Array.isArray(confs)) confs = [confs];

    for (const conf of confs) {
      if (conf.events) {
        const events = this.collectionsMap.get(conf.collection).get('events');
        for (const event of conf.events) {
          events.delete(mapTextToType[event]);
        } // for
      } // if
      if (conf.keys) {
        const keys = this.collectionsMap.get(conf.collection).get('keys');
        for (const key of conf.keys) {
          keys.delete(key);
        } // for
      }// if

      if (!conf.events && !conf.keys) {
        this.collectionsMap.delete(conf.collection);
      } // if
    } // for
  } // unsubscribe()
}

module.exports = ArangoChair;
