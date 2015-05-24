var NOTSET = {};

ReactiveObj = function (initialValue, options) {
  var self = this;
  self._obj = typeof initialValue === 'object' ? initialValue : {};
  self._deps = {children: {}, deps: {}};
  self._willInvalidate = [];
  self._willCleanDeps = [];

  if (!options) return;
  if (typeof options.transform === 'function')
    self._transform = options.transform;
};
_.extend(ReactiveObj.prototype, {

  _matchKeyPath: function (keyPath) {
    if (typeof keyPath === 'string') keyPath = [keyPath];
    else if (typeof keyPath === 'undefined') keyPath = [];
    else if (!(keyPath instanceof Array)) throw new Error('Invalid keypath');

    return keyPath;
  },

  _visitPath: function (node, keyPath, visitor) {
    for (var i=0, l=keyPath.length, s=node, lastS=null; i<l; i+=1) {
      if (typeof s === 'object' && keyPath[i] in s) {
        lastS = s;
        s = s[keyPath[i]];
      }
      else break;
    }
    if (i === l || !keyPath.length)
      return typeof visitor !== 'function' ? s : visitor({
        node: lastS,
        value: s,
        key: keyPath[i - 1]
      });

    return NOTSET;
  },

  // Shallow clone an object with new value at the path
  _copyOnWrite: function (node, path, value) {
    var prevNode = node;
    var newNode = {};
    var currentNode = newNode;
    var currentKey, currentValue;

    for (var i=0, l=path.length-1; i<=l; i+=1) {
      currentKey = path[i];
      if (i === l) currentValue = value;
      else {
        if (prevNode[currentKey] instanceof Array) currentValue = [];
        else currentValue = {};
      }

      if (prevNode) _.extend(currentNode, _.omit(prevNode, currentKey));

      currentNode[currentKey] = currentValue;
      currentNode = currentNode[currentKey];
      if (prevNode) prevNode = prevNode[currentKey];
    }

    return newNode;
  },

  _addDep: function (opt) {
    var self = this;
    var currentNode = self._deps;
    var nextNode;

    if (!opt.path.length) self._addDepToNode(self._deps, opt);

    for (var i=0, l=opt.path.length-1; i<=l; i+=1) {
      nextNode = currentNode.children[opt.path[i]] =
        currentNode.children[opt.path[i]] ||
        {children: {}, deps: {}};

      if (i === l) self._addDepToNode(nextNode, opt);

      currentNode = nextNode;
    }
  },

  _addDepToNode: function (node, opt) {
    node.deps[opt.id] = {
      comp: opt.comp,
      lastVal: opt.lastVal
    };
  },

  _removeDep: function (opt) {
    var self = this;
    var currentNode = self._deps;
    var nextNode;

    if (!opt.path.length) self._removeDepFromNode(self._deps, opt);

    for (var i=0, l=opt.path.length-1; i<=l; i+=1) {
      if (!currentNode) break;
      nextNode = currentNode.children[opt.path[i]];

      if (i === l) self._removeDepFromNode(nextNode, opt);

      currentNode = nextNode;
    }
  },

  _removeDepFromNode: function (node, opt) {
    var self = this;
    if (!node.deps[opt.id]) return;

    delete node.deps[opt.id];

    if (self._willCleanDeps.length === 0) {
      Tracker.afterFlush(function () {
        self._cleanDeps();
      });
    }
    self._willCleanDeps.push(opt.path);
  },

  _cleanDeps: function () {
    var self = this;
    var cleanPaths = _.chain(self._willCleanDeps)
    .uniq(function (v) {
      return JSON.stringify(v);
    })
    .sortBy(function (v) { return -1 * v.length; })
    .each(function (path) {
      var currentNode = self._deps;
      var nextNode;

      for (var i=0, l=path.length-1; i<=l; i+=1) {
        if (!currentNode || !currentNode.children) return;

        nextNode = currentNode.children[path[i]];
        if(i === l) {
          if (!_.size(nextNode.children) && !_.size(nextNode.deps))
            delete currentNode.children[path[i]];
        }
        currentNode = nextNode;
      }
    })
    .value();

    // Reset
    self._willCleanDeps = [];
  },

  get: function (keyPath, valueIfNotSet) {
    var self = this;
    var computation, id, value;
    keyPath = self._matchKeyPath(keyPath);

    value = self._visitPath(self._obj, keyPath);

    if (Tracker.active) {
      computation = Tracker.currentComputation;
      id = computation._id;
      self._addDep({
        id: id,
        path: keyPath,
        comp: computation,
        lastVal: value
      });
      Tracker.currentComputation.onInvalidate(function () {
        self._removeDep({path: keyPath, id: id});
      });
    }

    if (value === NOTSET) return valueIfNotSet;
    return self._transform ? self._transform(value) : value;
  },

  set: function (keyPath, value) {
    var self = this;
    var newState, noop;
    if (arguments.length < 2) throw new Error("No value to set");
    keyPath = self._matchKeyPath(keyPath);

    // Replace root node
    if (!keyPath.length) newState = value;

    // If value assigned is the same as the old value, it is a noop
    noop = self._visitPath(self._obj, keyPath, function (context) {
      if (context.value === value) return true;
    });
    if (noop === true) return self;

    // Replace state
    self._obj = newState || self._copyOnWrite(self._obj, keyPath, value);

    self.invalidate(keyPath);

    return self;
  },

  update: function (keyPath, valIfNotSet, updater) {
    var self = this;
    var useNotSetVal = true;
    var write = {};
    var oldVal, newVal;
    keyPath = self._matchKeyPath(keyPath);
    if (arguments.length < 2) throw new Error('Insufficient arguments');
    else if (arguments.length === 2) {
      updater = valIfNotSet;
      useNotSetVal = false;
    }
    if (typeof updater !== 'function')
      throw new Error('Invalid or missing updater function');

    oldVal = self._visitPath(self._obj, keyPath);
    if (oldVal === NOTSET) {
      if (useNotSetVal) write.value = valIfNotSet;
    }
    else {
      newVal = updater(self._transform ? self._transform(oldVal) : oldVal);
      if (oldVal !== newVal) write.value = newVal;
    }

    if ('value' in write) {
      self._obj = self._copyOnWrite(self._obj, keyPath, write.value);
      self.invalidate(keyPath);
    }

    return self;
  },

  invalidate: function (keyPath) {
    var self = this;

    // Calls invalidate later if not already
    if (self._willInvalidate.length === 0) {
      Tracker.afterFlush(function () {
        self._processInvalidations();
      });
    }

    if (typeof keyPath === 'string') keyPath = [keyPath];
    else if (!(keyPath instanceof Array)) keyPath = [];
    self._willInvalidate.push(keyPath);
  },

  forceInvalidate: function (keyPath, options) {
    var self = this;
    var path, lastNode;
    keyPath = self._matchKeyPath(keyPath);
    path = self._keyPathToDepPath(keyPath);
    options = options || {};

    self._visitPath(self._deps, path, function (context) {
      self._resetDeps(context.node.deps, options.all);
      lastNode = context.node;
    });

    if (lastNode)
      self._traverse(lastNode, function (nodeDes) {
        self._resetDeps(nodeDes.node.deps, options.all);
        return nodeDes.node.children;
      });

    self.invalidate(keyPath);
  },

  _resetDeps: function (deps, resetAll) {
    var depKeys = _.keys(deps);

    for (var i=0, l=depKeys.length, d, t; i<l; i+=1) {
      d = deps[depKeys[i]];
      if (resetAll) delete d.lastVal;
      else {
        t = typeof d.lastVal;
        if ((d.lastVal !== null && t === 'object') || t === 'function')
          delete d.lastVal;
      }
    };
  },

  _makePathTree: function (pathArr) {
    return _.chain(pathArr)
    .sortBy(function (keyPath) { return keyPath.length; })
    .reduce(function (tree, keyPath) {
      var currentPath = tree;
      if (tree === true) return tree;

      if (keyPath.length === 0) return tree = true;

      for (var i=0, l=keyPath.length - 1, v; i<=l; i+=1) {
        v = currentPath[keyPath[i]];

        if (v === true) return tree;

        if (i === l) currentPath[keyPath[i]] = true;
        else if (!v) currentPath[keyPath[i]] = {};

        currentPath = currentPath[keyPath[i]];
      }

      return tree;
    }, {})
    .value();
  },

  _traverse: function (tree, callback) {
    var queue = [];
    var next = {parent: null, node: tree, path: []};
    var nextNodes;

    while (next) {
      nextNodes = callback(next);
      if (typeof nextNodes === 'object') {
        _.each(nextNodes, function(node, k) {
          if (!node) return;
          queue.push({parent: next, node: node, path: next.path.concat(k)});
        });
      }
      next = queue.shift();
    }
  },

  _processInvalidations: function () {
    var self = this;
    var invalidTree;
    if (self._willInvalidate.length === 0) return;

    // Populate invalidation tree
    invalidTree = self._makePathTree(self._willInvalidate);

    self._invalidateTree(invalidTree);

    // Reset
    self._willInvalidate = [];
  },

  _invalidateTree: function (invalidTree) {
    var self = this;
    self._traverse(invalidTree, function (nodeDes) {
      self._invalidateComputation(
        nodeDes.path,
        nodeDes.node === true ? true : undefined
      );
      return nodeDes.node;
    });
  },

  _keyPathToDepPath: function (keyPath) {
    var path = ['children'];
    for (var i=0, l=keyPath.length; i<l; i+=1) {
      path.push(keyPath[i], 'children');
    }
    return path;
  },

  _invalidateComputation: function (keyPath, invalidateChildren) {
    var self = this;
    var path = self._keyPathToDepPath(keyPath);
    var lastNode;

    self._visitPath(self._deps, path, function (context) {
      self._invalidatePathDeps(keyPath, context.node.deps);
      lastNode = context.node;
    });

    if (lastNode && invalidateChildren)
      self._traverse(lastNode, function (nodeDes) {
        if (nodeDes.path.length) {
          var path = keyPath.concat(nodeDes.path);
          self._invalidatePathDeps(path, nodeDes.node.deps);
        }
        return nodeDes.node.children;
      });
  },

  _invalidatePathDeps: function (keyPath, deps) {
    var self = this;
    var depKeys = _.keys(deps);
    var val = self._visitPath(self._obj, keyPath);
    if (val === NOTSET) val = undefined;

    for (var i=0, l=depKeys.length, d; i<l; i+=1) {
      d = deps[depKeys[i]];
      if (!('lastVal' in d) || val !== d.lastVal) d.comp.invalidate();
    };
  }
});
