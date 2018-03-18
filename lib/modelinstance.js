'use strict';

var util = require('util');
var jsonpath = require('jsonpath');
var Schema = require('./schema');
var _ = require('lodash');
var Promise = require('bluebird');
var lodashDeep = require('lodash-deep');
_.mixin(lodashDeep);

function ModelData() {
  this.key = null;
  this.data = null;
  this.cas = null;
}

function ModelRefData() {
  this.key = null;
}

/**
 * Constructs a new model instance and for models with a default constructor,
 * applies the data in object passed to the instance.
 *
 * @param {Object} data
 * @constructor
 */
function ModelInstance() {
  // TODO: Remove this
  var args = arguments;

  var $ = this.$ = {};
  Object.defineProperty(this, '$', {
    enumerable: false
  });

  $.schema = this.constructor.schema;
  $.key = null;
  $.cas = null;
  $.loaded = false;
  $.refKeys = [];
  $.typeKey = $.schema.context.typeKey;

  if (args.length === 1 && args[0] instanceof ModelData) {
    $.key = args[0].key;
    ModelInstance.applyData(this, args[0]);
  } else if (args.length === 1 && args[0] instanceof ModelRefData) {
    $.key = args[0].key;
  } else {
    $.schema.applyDefaultsToObject(this);
    if (args.length === 1 && args[0] instanceof Object) {
      $.schema.applyUserDataToObject(this, args[0]);
    }
    $.schema.applyPropsToObj(this);
    $.loaded = true;
  }
}

/**
 * Creates a new instance of this Model from the data passed.
 *
 * @param {Object} data
 * @returns ModelInstance
 */
ModelInstance.fromData = function (data) {
  var md = new ModelData();
  md.data = data;

  var mdlInstance = new this(md);
  return mdlInstance;
};

/**
 * Applies the data passed in `data` to the model instance `mdlInst`.
 *
 * @param {ModelInstance} mdlInst
 * @param {Object} data
 */
ModelInstance.applyData = function (mdlInst, data) {
  if (!data instanceof ModelData) {
    throw new Error('ApplyData must be called with ModelData instance.');
  }

  var $ = mdlInst.$;
  if ($.key !== null && $.key !== data.key) {
    throw new Error('Tried to load data from wrong id.');
  }
  $.key = data.key;
  $.schema.applyDataToObject(mdlInst, data.data);
  $.cas = data.cas;
  $.loaded = true;
  $.refKeys = $.schema.refKeys(mdlInst);
};

/**
 * Creates a new ModelInstance with the passed data and then immediately
 * attempts to save it to the data store.
 *
 * @param {Object} data
 * @param {Function=} callback
 * @returns Promise
 */
ModelInstance.create = function (data, callback) {
  var self = this;
  var args = arguments;

  return new Promise(function (resolve, reject) {
    var ctorArgs = [''];
    for (var i = 0; i < args.length && !(args[i] instanceof Function); ++i) {
      ctorArgs.push(args[i]);
    }

    var mdlInst = // jshint -W058
      new (Function.prototype.bind.apply(self, ctorArgs));

    mdlInst.save(function (err) {
      if (err) {
        return reject(err);
      }
      return resolve(mdlInst);
    });
  }).asCallback(callback);
};

/**
 * Returns the full name of the model, including namespace.
 *
 * @returns {string}
 */
ModelInstance.namePath = function () {
  return this.schema.namePath();
};

/**
 * Returns whether this model instance is loaded or not.
 *
 * @returns {boolean}
 */
ModelInstance.prototype.loaded = function () {
  return this.$.loaded;
};

function _modelKey(mdl) {
  if (mdl.loaded()) {
    // Force key generation
    mdl.id();
  }
  // Return the key
  return mdl.$.key;
}

/**
 * Returns the ID of this model instance.
 *
 * @returns {string}
 */
ModelInstance.prototype.id = function () {
  var $ = this.$;
  if (!$.loaded) {
    var keyPrefix = $.schema.namePath() + '|';
    if ($.key.substr(0, keyPrefix.length) !== keyPrefix) {
      throw new Error('The key of this object appears incorrect.');
    }
    return $.key.substr(keyPrefix.length);
  }
  var myId = $.schema.fieldVal(this, this.$.schema.idField);
  var newKey = $.schema.namePath() + '|' + myId;
  if ($.key !== null) {
    if ($.key !== newKey) {
      throw new Error('The Key of the object has changed!');
    }
  } else {
    $.key = newKey;
  }
  return myId;
};

function _findField(fields, name) {
  for (var i = 0; i < fields.length; ++i) {
    if (fields[i].name === name) {
      return fields[i];
    }
  }
  return null;
}

function _encodeValue(context, type, value, forceTyping, f, typeKey) {
  if (context.isModel(type)) {
    if (!(value instanceof type)) {
      throw new Error('Expected ' + f.name + ' type to be a `' +
        type.name + '`');
    }
    return value._toCoo(type.name, forceTyping);
  } else if (type instanceof Schema.ListField) {
    if (!Array.isArray(value)) {
      throw new Error('Expected ' + f.name + ' type to be an array.');
    }
    var outArr = [];
    for (var i = 0; i < value.length; ++i) {
      outArr[i] = _encodeValue(context, type.type, value[i],
        forceTyping, f, typeKey);
    }
    return outArr;
  } else if (type instanceof Schema.FieldGroup) {
    if (!(value instanceof Object)) {
      throw new Error('Expected ' + f.name +
        ' object type but got non-object.');
    }
    var outObj = {};
    for (var j in value) {
      /* istanbul ignore else */
      if (value.hasOwnProperty(j)) {
        var field = _findField(type.fields, j);
        if (!field) {
          throw new Error('Cannot find field data for property `' + j + '`.');
        }
        outObj[j] = _encodeValue(context, field.type, value[j],
          forceTyping, field, typeKey);
      }
    }
    return outObj;
  } else if (type instanceof Schema.ModelRef) {
    if (!(value instanceof ModelInstance)) {
      throw new Error('Expected ' + f.name + ' type to be a ModelInstance.');
    }
    // Values must match stated type names, unless the reference is to
    // 'Mixed', then any reference will do.
    if (type.name !== value.$.schema.name && (type.name !== 'Mixed')) {
      throw new Error('Expected type to be `' +
        type.name + '` (got `' + value.$.schema.name + '`)');
    }
    var obj = {
      '$ref': value.id()
    };
    obj[typeKey] = value.$.schema.namePath();
    return obj;
  } else if (type === Schema.DateType) {
    if (!(value instanceof Date)) {
      // throw new Error('Expected ' + f.name + ' type to be a Date.');
      value = new Date(value);
    }
    try {
      return value.toISOString();
    } catch (err) {
      console.error('Invalid date ' + value + ' in ' + f.name);
      return null;
    }
  } else if (type === Schema.MixedType) {
    if (value instanceof ModelInstance) {
      return value._toCoo(type.name, forceTyping);
    } else if (value instanceof Date) {
      var dateObj = {
        'v': value.toISOString()
      };
      dateObj[typeKey] = 'Date';
      return dateObj;
    } else {
      return value;
    }
  } else {
    if (value instanceof Object) {
      throw new Error('Expected ' + f.name + ' non-object type ' +
        JSON.stringify(type) + ' but got object.');
    }
    return value;
  }
}

/**
 * Performs serialization of this object to JSON.
 *
 * @param {string} refType The type used to reference this object.
 * @param {boolean} forceTyping Whether to force the injection
 *    of a `_type` field.
 * @returns {Object}
 * @private
 * @ignore
 */
ModelInstance.prototype._toCoo = function (refType, forceTyping) {
  var $ = this.$;
  var objOut = {};
  var typeKey = $.typeKey;
  if (forceTyping || this.$.schema.name !== refType) {
    objOut[typeKey] = this.$.schema.namePath();
  }

  for (var i in this) {
    /* istanbul ignore else */
    if (this.hasOwnProperty(i)) {
      var field = $.schema.field(i);
      objOut[i] =
        _encodeValue($.schema.context, field.type, this[i],
          forceTyping, field, typeKey);
    }
  }
  return objOut;
};

/**
 * Returns a JSON database-serialized version of this
 *   model instance.
 *
 * @returns {Object}
 */
ModelInstance.prototype.toCoo = function () {
  return this._toCoo('Mixed', false);
};

/**
 * Returns a JSON serialized version of this model instance.
 *
 * The JSON serialized version is the same as the Coo, with certain internals
 * changed (references) so they are not exposed outside of the DB.
 *
 * @returns {Object}
 */
ModelInstance.prototype.toJSON = function(forceTyping) {
  if (!this.loaded()) {
    return null;
  }

  var cloneCache = [];
  function safeClone(obj, depth){
    if (depth > 10000){ // safety check
      console.warn('Depth limit exceeded, returning...');
      return '[Circular depth exceeded]';
    }
    if (cloneCache.indexOf(obj) > -1){ // check for circular dependency
      return '[Circular]';
    }
    var subClone = Array.isArray(obj) ? [] : {};
    cloneCache.push(obj);
    for (var key in obj) {
      if (!obj.hasOwnProperty(key)) { continue }
      var value = obj[key];
      if (value instanceof Date) {
        subClone[key] = value;
      } else if (typeof value === 'object' && value !== null){
        subClone[key] = safeClone(value, depth + 1);
      } else {
        subClone[key] = value;
      }
    }
    if (obj.toCoo) {
      if (Object.keys(subClone).length === 0) {
        subClone = {
          $ref: obj.id(),
          [obj.$.typeKey]: obj.$.schema.name
        }
      } else if (forceTyping) {
        subClone[obj.$.typeKey] = obj.$.schema.name;
      }
    }
    cloneCache.pop();
    return subClone;
  }

  var clone = safeClone(this, 0);
  return clone;
};


// /**
//  * A custom inspector to help with debugging of model instances.
//  *
//  * @private
//  * @ignore
//  */
// var cache = [];
// ModelInstance.prototype.inspect = function(depth) {
//   if (cache.indexOf(this) > -1){
//     return '[Circular]';
//   }
//   var res = '';
//   var name = this.$.schema.name;
//   if (!name) {
//     name = 'unnamed';
//   }
//   var attribs = [];
//   if (this.$.loaded) {
//     attribs.push('loaded');
//   } else {
//     attribs.push('unloaded');
//   }
//   attribs.push('key:' + this.$.key);

//   res += 'OttomanModel(`' + name + '`, ' + attribs.join(', ') + ', {';
//   var hasProperties = false;
//   for (var i in this) {
//     /* istanbul ignore else */
//     if (this.hasOwnProperty(i)) {
//       if (!hasProperties) {
//           res += '\n';
//           hasProperties = true;
//       }
//       res += '  ' + i + ': ';
//       cache.push(this);
//       res += util.inspect(this[i]).replace(/\n/g, '\n  ');
//       cache.pop();
//       res += ',\n';
//     }
//   }
//   res += '})';
//   return res;
// };


/**
 * A custom inspector to help with debugging of model instances.
 *
 * @private
 * @ignore
 */
ModelInstance.prototype.inspect = function () {
  var res = '';
  var name = this.$.schema.name;
  if (!name) {
    name = 'unnamed';
  }
  var attribs = [];
  if (this.$.loaded) {
    attribs.push('loaded');
  } else {
    attribs.push('unloaded');
  }
  attribs.push('key:' + this.$.key);

  res += 'OttomanModel(`' + name + '`, ' + attribs.join(', ') + ', {';
  var hasProperties = false;
  for (var i in this) {
    /* istanbul ignore else */
    if (this.hasOwnProperty(i)) {
      if (!hasProperties) {
        res += '\n';
        hasProperties = true;
      }
      res += '  ' + i + ': ';
      res += util.inspect(this[i]).replace(/\n/g, '\n  ');
      res += ',\n';
    }
  }
  res += '})';
  return res;
};

function _tryAddRefs(bucket, keys, refKey, callback) {
  if (keys.length === 0) {
    callback(null);
    return;
  }
  var errs = [];
  var i = 0;
  function stepBackward() {
    if (i === -1) {
      if (errs.length > 1) {
        var err = new Error('CRITICAL Error occured while storing refdoc.');
        err.errors = errs;
        callback(err);
      } else {
        callback(errs[0]);
      }
      return;
    }
    var key = keys[i--];
    bucket.remove(key, null, function (err) {
      if (err) {
        errs.push(err);
      }
      stepBackward();
    });
  }
  function stepForward() {
    if (i === keys.length) {
      callback(null);
      return;
    }
    var key = keys[i++];
    bucket.store(key, refKey, null, function (err) {
      if (err) {
        errs.push(err);
        i -= 2;
        stepBackward();
        return;
      }
      stepForward();
    });
  }
  stepForward();
}

function _tryRemoveRefs(bucket, keys, callback) {
  if (keys.length === 0) {
    callback(null);
    return;
  }
  var proced = 0;
  function handler() {
    proced++;
    if (proced === keys.length) {
      callback(null);
      return;
    }
  }
  for (var i = 0; i < keys.length; ++i) {
    bucket.remove(keys[i], null, handler);
  }
}


/**
 * Saves this model instance to the data store.
 *
 * @param {Function=} callback
 * @returns Promise
 */
ModelInstance.prototype.save = function (callback) {
  var self = this;
  var $ = this.$;

  return new Promise(function (resolve, reject) {

    // Attempt to validate this object
    $.schema.execPreHandlers('save', self, function (err) {
      if (err) {
        return reject(err);
      }

      $.schema.validate(self, function (err) {
        if (err) {
          return reject(err);
        }

        var newKey = _modelKey(self);
        var newData = self.toCoo();
        var newRefKeys = $.schema.refKeys(self);

        var oldRefKeys = $.refKeys;
        var addedRefKeys = [];
        var removedRefKeys = [];
        for (var i = 0; i < newRefKeys.length; ++i) {
          if (oldRefKeys.indexOf(newRefKeys[i]) === -1) {
            addedRefKeys.push(newRefKeys[i]);
          }
        }
        for (var j = 0; j < oldRefKeys.length; ++j) {
          if (newRefKeys.indexOf(oldRefKeys[j]) === -1) {
            removedRefKeys.push(oldRefKeys[j]);
          }
        }

        _tryAddRefs($.schema.store, addedRefKeys, $.key, function (err) {
          if (err) {
            return reject(err);
          }

          $.schema.store.store(newKey, newData, $.cas, function (err, cas) {
            if (err) {
              return reject(err);
            }

            $.cas = cas;
            $.refKeys = newRefKeys;

            _tryRemoveRefs($.schema.store, removedRefKeys, function (err) {
              if (err) {
                return reject(err);
              }

              $.schema.execPostHandlers('save', self, function (err, result) {
                if (err) {
                  return reject(err);
                }
                return resolve(result);
              });
            });
          });
        });
      });
    });
  }).asCallback(callback);
};

/**
 * This is a helper method which allows us to load an array of
 *   model instances all at once.
 *
 * @param {ModelInstance[]} items
 * @param {Function=} callback
 * @returns Promise
 */
ModelInstance.loadAll = function (items, callback) {
  return new Promise(function (resolve, reject) {
    if (!Array.isArray(items)) {
      return reject(new Error('Must pass an array to loadAll'));
    }

    var subItems = [];
    for (var i = 0; i < items.length; ++i) {
      if (items[i] && items[i] instanceof ModelInstance && !items[i].loaded()) {
        subItems.push(items[i]);
      }
    }

    var numSubLoadLeft = subItems.length;
    if (numSubLoadLeft > 0) {
      var subLoadOne = function () {
        numSubLoadLeft--;
        if (numSubLoadLeft === 0) {
          return resolve(null);
        }
      };
      for (var j = 0; j < subItems.length; ++j) {
        subItems[j].load(subLoadOne);
      }
    } else {
      return resolve(null);
    }
  }).asCallback(callback);
};

/**
 * Loads this object, or sub-objects from this object from the data store.
 * This function can be called while a model instance is already loaded to
 * reload the model instance, or to load specific sub-model-instances.
 *
 * @param {...string=} paths Paths to sub-model-instances to load.
 * @param {Function} callback
 * @returns Promise
 */
ModelInstance.prototype.load = function () {
  var loadItems = [];
  var finalCallback = function () { };
  for (var i = 0; i < arguments.length; ++i) {
    if (arguments[i] instanceof Function) {
      finalCallback = arguments[i];
      break;
    } else {
      loadItems.push(arguments[i]);
    }
  }

  var self = this;
  var $ = self.$;

  return new Promise(function (resolve, reject) {
    function loadSubItem() {
      if (loadItems.length === 0) {
        return resolve(null);
      }

      var mdlsToLoad = [];

      var paths = loadItems.shift();
      if (paths === '') {
        loadSubItem();
        return;
      }

      if (!Array.isArray(paths)) {
        paths = [paths];
      }

      paths.forEach(function (path) {
        var items = jsonpath.query(self, path, 1000000);
        items.forEach(function (item) {
          if (Array.isArray(item)) {
            item.forEach(function (subItem) {
              if (subItem instanceof ModelInstance) {
                mdlsToLoad.push(subItem);
              }
            });
          } else if (item instanceof ModelInstance) {
            mdlsToLoad.push(item);
          }
        });
      });

      ModelInstance.loadAll(mdlsToLoad, loadSubItem);
    }

    if (!self.loaded()) {
      $.schema.execPreHandlers('load', self, function () {
        var key = _modelKey(self);
        $.schema.store.get(key, function (err, data, cas) {
          if (err) {
            return reject(err);
          }

          var md = new ModelData();
          md.key = $.key;
          md.data = data;
          md.cas = cas;
          ModelInstance.applyData(self, md);
          loadSubItem();

          var deadEnd = function () { };
          $.schema.execPostHandlers('load', self, deadEnd);
        });
      });
    } else {
      loadSubItem();
    }
  }).asCallback(finalCallback);
};

/**
 * Removes this model instance from the data store.
 *
 * @param {Function=} callback
 * @returns Promise
 */
ModelInstance.prototype.remove = function (callback) {
  var $ = this.$;
  var self = this;
  var key = _modelKey(this);

  return new Promise(function (resolve, reject) {
    // TODO: Fix this not to use refKeys
    // Check that we can generate refKeys, which implicitly checks
    //  that we are loaded if we need to be (because we have refdoc
    //  indices on this model).
    try {
      $.schema.refKeys(self);
    } catch (e) {
      return reject(e);
    }

    $.schema.execPreHandlers('remove', self, function () {
      // Remove the document itself first, then remove any
      //  reference keys.  This order is important as if the
      //  reference keys fail to get removed, the references
      //  will still point to nothing.
      $.schema.store.remove(key, $.cas, function (err) {
        if (err) {
          return reject(err);
        }

        _tryRemoveRefs($.schema.store, $.refKeys, function (err) {
          if (err) {
            return reject(err);
          }

          var deadEnd = function (err) {
            if (err) {
              console.log('Ottoman post-save handler returned ' + err);
            }
          };

          $.schema.execPostHandlers('remove', self, deadEnd);
          return resolve(null);
        });
      });
    });
  }).asCallback(callback);
};

/**
 * Perform a filter based search to locate specific model instances.
 *
 * @param {Object} filter
 * @param {Object=} options
 *  @param {string|string[]} options.sort
 *  @param {number} options.limit
 *  @param {number} options.skip
 * @param {Function=} callback
 * @returns Promise
 */
ModelInstance.find = function (filter, options, callback) {
  var findModels = Promise.promisify(this.schema.context._findModels, {
    context: this.schema.context
  });

  return findModels(this, filter, options).asCallback(callback);
};

/**
 * Performs a count of the objects matching the filter in the data store.
 *
 * @param {Object} filter
 * @param {Object=} options
 *  @param {string|string[]} options.sort
 *  @param {number} options.limit
 *  @param {number} options.skip
 * @param {Function=} callback
 * @returns Promise
 */
ModelInstance.count = function (filter, options, callback) {
  var countModels = Promise.promisify(this.schema.context._countModels, {
    context: this.schema.context
  });

  return countModels(this, filter, options).asCallback(callback);
};

/**
 * Retrieves a specific model instance from the data store by ID.
 *
 * @param {string} id
 * @param {Object=} options
 * @param {Function=} callback
 * @returns Promise
 */
ModelInstance.getById = function (id, options, callback) {
  var mdl = this.ref(id);

  if (!options) {
    options = {};
  } else if (options instanceof Function) {
    callback = options;
    options = {};
  }

  return new Promise (function (resolve, reject) {
    var loadArgs = [function (err) {
      if (err) {
        return reject(err);
      }
      return resolve(mdl);
    }];
    if (options.load) {
      loadArgs = options.load.concat(loadArgs);
    }
    mdl.load.apply(mdl, loadArgs);
  }).asCallback(callback);
}

/**
 * Creates an unloaded model instance referencing a data store item by key.
 *
 * @param {string} key
 * @returns {ModelInstance}
 */
ModelInstance.refByKey = function (key) {
  var mr = new ModelRefData();
  mr.key = key;
  return new this(mr);
};

/**
 * Registers a plugin for this model.  This function will be
 * called immediately with the model itself as the first argument,
 * and the provided options as the second argument.
 * @param {pluginFn} the plugin function.
 * @param {option} options object to pass to the plugin.
 * @returns {ModelInstance}
 */
ModelInstance.plugin = function (pluginFn, options) {
  if (!(pluginFn instanceof Function)) {
    throw new Error('Ottoman plugins must be functions');
  }

  pluginFn(this, (options || {}));
  return this;
};

/**
 * Creates an unloaded model instance referencing a data store item by id.
 *
 * @param {string} id
 * @returns {ModelInstance}
 */
ModelInstance.ref = function (id) {
  return this.refByKey(this.schema.namePath() + '|' + id);
};

/**
 * Specify a handler to be invoked prior to a particular event for this
 * ModelInstance.  The handler will always be called with two arguments:
 * the model instance, and a callback function that the handler should
 * call to continue processing.  If a pre handler calls the provided
 * callback with an error, the event will not continue.
 *
 * @param {"validate"|"save"|"load"|"remove"} event
 * @param {Function} handler
 */
ModelInstance.pre = function (event, handler) {
  return this.schema.addPreHandler(event, handler);
};

/**
 * Specify a function to be invoked following a particular event on this
 * ModelInstance.  The handler will always be called with two arguments:
 * the model instance, and a callback.
 *
 * @param {"validate"|"save"|"load"|"remove"} event
 * @param {Function} fn
 */
ModelInstance.post = function (event, fn) {
  return this.schema.addPostHandler(event, fn);
};

module.exports = ModelInstance;
