#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/yaml/dist/nodes/identity.js"(exports) {
    "use strict";
    var ALIAS = Symbol.for("yaml.alias");
    var DOC = Symbol.for("yaml.document");
    var MAP = Symbol.for("yaml.map");
    var PAIR = Symbol.for("yaml.pair");
    var SCALAR = Symbol.for("yaml.scalar");
    var SEQ = Symbol.for("yaml.seq");
    var NODE_TYPE = Symbol.for("yaml.node.type");
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
    exports.ALIAS = ALIAS;
    exports.DOC = DOC;
    exports.MAP = MAP;
    exports.NODE_TYPE = NODE_TYPE;
    exports.PAIR = PAIR;
    exports.SCALAR = SCALAR;
    exports.SEQ = SEQ;
    exports.hasAnchor = hasAnchor;
    exports.isAlias = isAlias;
    exports.isCollection = isCollection;
    exports.isDocument = isDocument;
    exports.isMap = isMap;
    exports.isNode = isNode;
    exports.isPair = isPair;
    exports.isScalar = isScalar;
    exports.isSeq = isSeq;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports) {
    "use strict";
    var identity = require_identity();
    var BREAK = Symbol("break visit");
    var SKIP = Symbol("skip children");
    var REMOVE = Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports.visit = visit;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports.Directives = Directives;
  }
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/yaml/dist/doc/anchors.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports.anchorIsValid = anchorIsValid;
    exports.anchorNames = anchorNames;
    exports.createNodeAnchors = createNodeAnchors;
    exports.findNewAnchor = findNewAnchor;
  }
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/yaml/dist/doc/applyReviver.js"(exports) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports.applyReviver = applyReviver;
  }
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/yaml/dist/nodes/toJS.js"(exports) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports.toJS = toJS;
  }
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/yaml/dist/nodes/Node.js"(exports) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports.NodeBase = NodeBase;
  }
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/yaml/dist/nodes/Alias.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var visit = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports.Alias = Alias;
  }
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/yaml/dist/nodes/Scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports.Scalar = Scalar;
    exports.isScalarValue = isScalarValue;
  }
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/yaml/dist/doc/createNode.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports.createNode = createNode;
  }
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/yaml/dist/nodes/Collection.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports.Collection = Collection;
    exports.collectionFromPath = collectionFromPath;
    exports.isEmptyPath = isEmptyPath;
  }
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyComment.js"(exports) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports.indentComment = indentComment;
    exports.lineComment = lineComment;
    exports.stringifyComment = stringifyComment;
  }
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/yaml/dist/stringify/foldFlowLines.js"(exports) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
        }
      }
      return end;
    }
    exports.FOLD_BLOCK = FOLD_BLOCK;
    exports.FOLD_FLOW = FOLD_FLOW;
    exports.FOLD_QUOTED = FOLD_QUOTED;
    exports.foldFlowLines = foldFlowLines;
  }
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyString.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports.stringifyString = stringifyString;
  }
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/yaml/dist/stringify/stringify.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify3(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports.createStringifyContext = createStringifyContext;
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify3.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify3.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports.stringifyPair = stringifyPair;
  }
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/yaml/dist/log.js"(exports) {
    "use strict";
    var node_process = __require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports.debug = debug;
    exports.warn = warn;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports.addMergeToJSMap = addMergeToJSMap;
    exports.isMergeKey = isMergeKey;
    exports.merge = merge;
  }
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify3 = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify3.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/yaml/dist/nodes/Pair.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports.Pair = Pair;
    exports.createPair = createPair;
  }
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyCollection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify4 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify4(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify3.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify3.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports.stringifyCollection = stringifyCollection;
  }
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLMap.js"(exports) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports.YAMLMap = YAMLMap;
    exports.findPair = findPair;
  }
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/yaml/dist/schema/common/map.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports.map = map;
  }
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLSeq.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports.YAMLSeq = YAMLSeq;
  }
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/yaml/dist/schema/common/seq.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports.seq = seq;
  }
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/yaml/dist/schema/common/string.js"(exports) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports.string = string;
  }
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/yaml/dist/schema/common/null.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports.nullTag = nullTag;
  }
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/yaml/dist/schema/core/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports.boolTag = boolTag;
  }
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyNumber.js"(exports) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports.stringifyNumber = stringifyNumber;
  }
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/yaml/dist/schema/core/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/yaml/dist/schema/core/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/yaml/dist/schema/core/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/yaml/dist/schema/json/schema.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports) {
    "use strict";
    var node_buffer = __require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports.binary = binary;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports.createPairs = createPairs;
    exports.pairs = pairs;
    exports.resolvePairs = resolvePairs;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports.YAMLOMap = YAMLOMap;
    exports.omap = omap;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports.falseTag = falseTag;
    exports.trueTag = trueTag;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intBin = intBin;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports.YAMLSet = YAMLSet;
    exports.set = set;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports.floatTime = floatTime;
    exports.intTime = intTime;
    exports.timestamp = timestamp;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/yaml/dist/schema/tags.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports.coreKnownTags = coreKnownTags;
    exports.getTags = getTags;
  }
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/yaml/dist/schema/Schema.js"(exports) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports.Schema = Schema;
  }
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyDocument.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify3 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify3.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify3.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify3.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports.stringifyDocument = stringifyDocument;
  }
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/yaml/dist/doc/Document.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports.Document = Document;
  }
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/yaml/dist/errors.js"(exports) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports.YAMLError = YAMLError;
    exports.YAMLParseError = YAMLParseError;
    exports.YAMLWarning = YAMLWarning;
    exports.prettifyError = prettifyError;
  }
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/yaml/dist/compose/resolve-props.js"(exports) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports.resolveProps = resolveProps;
  }
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/yaml/dist/compose/util-contains-newline.js"(exports) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports.containsNewline = containsNewline;
  }
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/yaml/dist/compose/util-map-includes.js"(exports) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports.mapIncludes = mapIncludes;
  }
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-map.js"(exports) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep: sep3, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep3?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep3) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep3 ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep3, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-seq.js"(exports) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/yaml/dist/compose/resolve-end.js"(exports) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep3 = "";
        for (const token of end) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep3 + cb;
              sep3 = "";
              break;
            }
            case "newline":
              if (comment)
                sep3 += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports.resolveEnd = resolveEnd;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep: sep3, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep3?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep3 && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap && !sep3 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep3, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep3 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep3)
                for (const st of sep3) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep3, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/yaml/dist/compose/compose-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports.composeCollection = composeCollection;
  }
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep3 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep3 + indent.slice(trimIndent) + content;
          sep3 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep3 === " ")
            sep3 = "\n";
          else if (!prevMoreIndented && sep3 === "\n")
            sep3 = "\n\n";
          value += sep3 + indent.slice(trimIndent) + content;
          sep3 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep3 === "\n")
            value += "\n";
          else
            sep3 = "\n";
        } else {
          value += sep3 + content;
          sep3 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return foldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function foldLines(source) {
      let first, line;
      try {
        first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first = /(.*?)[ \t]*\r?\n/sy;
        line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match = first.exec(source);
      if (!match)
        return source;
      let res = match[1];
      let sep3 = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep3 === "\n")
            res += sep3;
          else
            sep3 = "\n";
        } else {
          res += sep3 + match[1];
          sep3 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep3 + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/yaml/dist/compose/compose-scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports.composeScalar = composeScalar;
  }
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/yaml/dist/compose/compose-node.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports.composeEmptyNode = composeEmptyNode;
    exports.composeNode = composeNode;
  }
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/yaml/dist/compose/compose-doc.js"(exports) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports.composeDoc = composeDoc;
  }
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/yaml/dist/compose/composer.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (node_process.env.LOG_STREAM)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports.Composer = Composer;
  }
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/yaml/dist/parse/cst-scalar.js"(exports) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = (pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        };
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body;
      } else {
        const { offset } = token;
        const indent = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent, source, end });
        }
      }
    }
    exports.createScalarToken = createScalarToken;
    exports.resolveAsScalar = resolveAsScalar;
    exports.setScalarValue = setScalarValue;
  }
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/yaml/dist/parse/cst-stringify.js"(exports) {
    "use strict";
    var stringify3 = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep: sep3, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep3)
        for (const st of sep3)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    var BREAK = Symbol("break visit");
    var SKIP = Symbol("skip children");
    var REMOVE = Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field, index] of path) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path) => {
      const parent = visit.itemAtPath(cst, path.slice(0, -1));
      const field = path[path.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports.visit = visit;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token) => !!token && "items" in token;
    var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports.createScalarToken = cstScalar.createScalarToken;
    exports.resolveAsScalar = cstScalar.resolveAsScalar;
    exports.setScalarValue = cstScalar.setScalarValue;
    exports.stringify = cstStringify.stringify;
    exports.visit = cstVisit.visit;
    exports.BOM = BOM;
    exports.DOCUMENT = DOCUMENT;
    exports.FLOW_END = FLOW_END;
    exports.SCALAR = SCALAR;
    exports.isCollection = isCollection;
    exports.isScalar = isScalar;
    exports.prettyToken = prettyToken;
    exports.tokenType = tokenType;
  }
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/yaml/dist/parse/lexer.js"(exports) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports.Lexer = Lexer;
  }
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/yaml/dist/parse/line-counter.js"(exports) {
    "use strict";
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports.LineCounter = LineCounter;
  }
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/yaml/dist/parse/parser.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token = error ?? this.stack.pop();
        if (!token) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep3;
          if (scalar.end) {
            sep3 = scalar.end;
            sep3.push(this.sourceToken);
            delete scalar.end;
          } else
            sep3 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep: sep3 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep3 = it.sep;
                  sep3.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep: sep3 }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep3 = fc.end.splice(1, fc.end.length);
            sep3.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep: sep3 }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports.Parser = Parser;
  }
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/yaml/dist/public-api.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse4(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify3(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports.parse = parse4;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument;
    exports.stringify = stringify3;
  }
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/yaml/dist/index.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports.Composer = composer.Composer;
    exports.Document = Document.Document;
    exports.Schema = Schema.Schema;
    exports.YAMLError = errors.YAMLError;
    exports.YAMLParseError = errors.YAMLParseError;
    exports.YAMLWarning = errors.YAMLWarning;
    exports.Alias = Alias.Alias;
    exports.isAlias = identity.isAlias;
    exports.isCollection = identity.isCollection;
    exports.isDocument = identity.isDocument;
    exports.isMap = identity.isMap;
    exports.isNode = identity.isNode;
    exports.isPair = identity.isPair;
    exports.isScalar = identity.isScalar;
    exports.isSeq = identity.isSeq;
    exports.Pair = Pair.Pair;
    exports.Scalar = Scalar.Scalar;
    exports.YAMLMap = YAMLMap.YAMLMap;
    exports.YAMLSeq = YAMLSeq.YAMLSeq;
    exports.CST = cst;
    exports.Lexer = lexer.Lexer;
    exports.LineCounter = lineCounter.LineCounter;
    exports.Parser = parser.Parser;
    exports.parse = publicApi.parse;
    exports.parseAllDocuments = publicApi.parseAllDocuments;
    exports.parseDocument = publicApi.parseDocument;
    exports.stringify = publicApi.stringify;
    exports.visit = visit.visit;
    exports.visitAsync = visit.visitAsync;
  }
});

// src/detect.js
import { readdir as readdir2 } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// src/fs-util.js
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
function resolveDir(dir) {
  return dir instanceof URL ? fileURLToPath(dir) : dir;
}
function dirFromImportMeta(importMetaUrl, rel) {
  return fileURLToPath(new URL(rel, importMetaUrl));
}
async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
    throw err;
  }
}
async function readJson(p) {
  let raw;
  try {
    raw = await readFile(p, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    process.stderr.write(`muster: warning: ${p} is present but not valid JSON
`);
    return null;
  }
}
async function readdirSafe(p) {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

// src/detect.js
var pexec = promisify(execFile);
async function git(cwd, args) {
  try {
    const { stdout } = await pexec("git", args, { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}
var FRAMEWORKS = [
  "next",
  "react-native",
  "expo",
  "react",
  "vue",
  "svelte",
  "angular",
  "express",
  "fastify",
  "nestjs",
  "prisma",
  "vite"
];
var FRONTEND = /* @__PURE__ */ new Set(["react", "vue", "svelte", "angular", "vite", "next"]);
var BACKEND = /* @__PURE__ */ new Set(["express", "fastify", "nestjs", "prisma"]);
var AI_SDKS = /* @__PURE__ */ new Set([
  "@anthropic-ai/sdk",
  "openai",
  "langchain",
  "@langchain/core",
  "llamaindex",
  "@google/generative-ai",
  "cohere-ai",
  "ai",
  "@modelcontextprotocol/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "@langchain/langgraph"
]);
var AI_SCOPES = ["@langchain/", "@ai-sdk/", "@llamaindex/"];
var hasAiSdk = (depNames) => depNames.some((d) => AI_SDKS.has(d) || AI_SCOPES.some((s) => d.startsWith(s)));
async function hasPromptingSignal(cwd) {
  const pkg = await readJson(join(cwd, "package.json"));
  if (!pkg) return false;
  return hasAiSdk(Object.keys({ ...pkg.dependencies || {}, ...pkg.devDependencies || {} }));
}
async function detectProject(cwd) {
  const pkg = await readJson(join(cwd, "package.json"));
  const isRepo = await exists(join(cwd, ".git"));
  const entries = await readdir2(cwd).catch(() => []);
  const greenfield = !pkg && !isRepo && entries.filter((e) => e !== ".git").length === 0;
  const deps = pkg ? { ...pkg.dependencies || {}, ...pkg.devDependencies || {} } : {};
  const depNames = Object.keys(deps);
  const languages = [];
  if (pkg) languages.push("javascript");
  if (await exists(join(cwd, "tsconfig.json")) || depNames.includes("typescript")) languages.push("typescript");
  const frameworks = FRAMEWORKS.filter((f) => depNames.includes(f));
  let packageManager = "unknown";
  if (await exists(join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (await exists(join(cwd, "yarn.lock"))) packageManager = "yarn";
  else if (await exists(join(cwd, "package-lock.json"))) packageManager = "npm";
  else if (pkg) packageManager = "npm";
  let testRunner = "unknown";
  for (const t of ["vitest", "jest", "mocha", "ava"]) if (depNames.includes(t)) {
    testRunner = t;
    break;
  }
  let shape = "unknown";
  const hasFE = depNames.some((d) => FRONTEND.has(d));
  const hasBE = depNames.some((d) => BACKEND.has(d));
  if (depNames.includes("react-native") || depNames.includes("expo")) shape = "mobile";
  else if (hasFE && hasBE) shape = "fullstack";
  else if (hasFE) shape = "frontend";
  else if (hasBE) shape = "backend";
  else if (pkg && (pkg.main || pkg.exports) && !hasFE && !hasBE) shape = "library";
  if (await exists(join(cwd, "pnpm-workspace.yaml")) || pkg && pkg.workspaces) shape = "monorepo";
  let branch = null, dirty = false, hasRemote = false;
  if (isRepo) {
    branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
    const statusOut = await git(cwd, ["status", "--porcelain"]);
    dirty = statusOut !== null && statusOut !== "";
    const remoteOut = await git(cwd, ["remote"]);
    hasRemote = !!(remoteOut && remoteOut !== "");
  }
  const signals = [...frameworks];
  if (hasAiSdk(depNames)) signals.push("prompting");
  return {
    greenfield,
    languages,
    frameworks,
    shape,
    packageManager,
    testRunner,
    vcs: { isRepo, branch, dirty, hasRemote },
    signals
  };
}

// src/catalog.js
var import_yaml = __toESM(require_dist(), 1);
import { readdir as readdir3, readFile as readFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";

// src/roles.js
var ROLES = [
  "code-navigation",
  "docs-research",
  "brainstorm",
  "plan",
  "implement",
  "code-review",
  "security-review",
  "test-author",
  "refactor",
  "frontend",
  "tech-debt",
  "debug",
  "author",
  "research",
  "score",
  "architecture-review",
  "browser-control",
  "computer-control",
  "performance",
  "seo",
  "humanize",
  "prompt-quality",
  "improve",
  "image",
  "video",
  "lifecycle"
];

// src/catalog.js
var ROLES2 = new Set(ROLES);
var DETECT_KINDS = /* @__PURE__ */ new Set(["plugin", "skill", "mcp_server", "agent"]);
function validateCatalog(entries) {
  const errors = [];
  if (!Array.isArray(entries)) return { ok: false, errors: ["catalog must be an array"] };
  entries.forEach((e, i) => {
    const at = `entry[${i}]`;
    if (!e.id) errors.push(`${at}: missing id`);
    if (e.kind !== "external" && e.kind !== "builtin" && e.kind !== "agent") errors.push(`${at}: kind must be external|builtin|agent`);
    if (!Array.isArray(e.roles) || e.roles.length === 0) errors.push(`${at}: roles must be a non-empty array`);
    else for (const r of e.roles) if (!ROLES2.has(r)) errors.push(`${at}: unknown role "${r}"`);
    if (typeof e.rank !== "number") errors.push(`${at}: rank must be a number`);
    if (e.kind === "external" && (!e.detect || !e.detect.kind || !e.detect.match))
      errors.push(`${at}: external entry needs detect.{kind,match}`);
    else if (e.kind === "external" && e.detect && e.detect.kind && !DETECT_KINDS.has(e.detect.kind))
      errors.push(`${at}: unknown detect.kind "${e.detect.kind}" (must be plugin|skill|mcp_server|agent)`);
    if ((e.kind === "builtin" || e.kind === "agent") && (!e.provenance || !e.provenance.license))
      errors.push(`${at}: ${e.kind} entry needs provenance.license (adapted_from for vendored, inspired_by for clean-room)`);
    if (e.description !== void 0 && typeof e.description !== "string")
      errors.push(`${at}: description must be a string`);
  });
  return { ok: errors.length === 0, errors };
}
async function loadCatalog(dir) {
  const base = resolveDir(dir);
  const files = (await readdir3(base)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  let entries = [];
  for (const f of files) entries = entries.concat((0, import_yaml.parse)(await readFile2(join2(base, f), "utf8")) || []);
  const { ok, errors } = validateCatalog(entries);
  if (!ok) throw new Error("Invalid catalog:\n" + errors.join("\n"));
  return entries;
}

// src/harness.js
import { join as join5 } from "node:path";

// src/plugin-inventory.js
import { join as join3, dirname } from "node:path";
import { readFileSync, readdirSync, existsSync, lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";

// src/frontmatter.js
var FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
function matchFrontmatter(text) {
  const str = String(text);
  const m = str.match(FRONTMATTER_RE);
  if (!m) return null;
  return { raw: m[0], body: m[1], rest: str.slice(m[0].length) };
}

// src/plugin-inventory.js
async function isSymlink(p) {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}
function isSymlinkSync(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function pluginName(key) {
  return key.split("@")[0];
}
async function serversFromPluginRoot(root) {
  const names = [];
  const mcp = await readJson(join3(root, ".mcp.json"));
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    const wrapped = mcp.mcpServers && typeof mcp.mcpServers === "object" && !Array.isArray(mcp.mcpServers);
    const map = wrapped ? mcp.mcpServers : mcp;
    for (const [name, cfg] of Object.entries(map)) {
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) names.push(name);
    }
  }
  const pj = await readJson(join3(root, ".claude-plugin/plugin.json"));
  if (pj && pj.mcpServers && typeof pj.mcpServers === "object" && !Array.isArray(pj.mcpServers)) {
    names.push(...Object.keys(pj.mcpServers));
  }
  return names;
}
async function agentsFromPluginRoot(root) {
  const agentsDir2 = join3(root, "agents");
  if (await isSymlink(agentsDir2)) return [];
  return (await readdirSafe(agentsDir2)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
}
async function skillsFromPluginRoot(root) {
  const found = [];
  const skillsDir = join3(root, "skills");
  if (await isSymlink(skillsDir)) return found;
  for (const name of await readdirSafe(skillsDir)) {
    const skillDir = join3(skillsDir, name);
    if (await isSymlink(skillDir)) continue;
    const skillMd = join3(skillDir, "SKILL.md");
    if ((await readdirSafe(skillDir)).includes("SKILL.md") && !await isSymlink(skillMd)) {
      found.push(name);
    }
  }
  return found;
}
function descriptionFromSkillMdSync(path) {
  if (isSymlinkSync(path) || isSymlinkSync(dirname(path)) || isSymlinkSync(dirname(dirname(path)))) return "";
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  const fm = matchFrontmatter(text);
  if (!fm) return "";
  const lines = fm.body.split(/\r?\n/);
  const descLine = lines.find((l) => /^description:/.test(l));
  if (descLine === void 0) return "";
  let value = descLine.slice("description:".length).trim();
  if (/^[|>][-+]?\d*$/.test(value)) {
    const first = lines.slice(lines.indexOf(descLine) + 1).find((l) => l.trim() !== "");
    return first ? first.trim() : "";
  }
  if (value.length >= 2) {
    const first = value[0], last = value[value.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") {
      value = value.slice(1, -1);
    }
  }
  return value;
}
function readdirSyncCached(dir, cache) {
  if (!cache.dirs) cache.dirs = /* @__PURE__ */ new Map();
  if (cache.dirs.has(dir)) return cache.dirs.get(dir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  cache.dirs.set(dir, entries);
  return entries;
}
function installPathsFromIndexSync(pluginsBase, cache) {
  if (cache.installPaths) return cache.installPaths;
  let index = null;
  try {
    index = JSON.parse(readFileSync(join3(pluginsBase, "installed_plugins.json"), "utf8"));
  } catch {
    index = null;
  }
  const paths = [];
  if (index && index.plugins && typeof index.plugins === "object" && !Array.isArray(index.plugins)) {
    for (const recs of Object.values(index.plugins)) {
      for (const rec of Array.isArray(recs) ? recs : []) {
        if (rec && typeof rec.installPath === "string") paths.push(rec.installPath);
      }
    }
  }
  cache.installPaths = paths;
  return paths;
}
function findSkillMdSync(base, name, maxDepth = 4, cache = {}) {
  for (const installPath of installPathsFromIndexSync(base, cache)) {
    const candidate = join3(installPath, "skills", name, "SKILL.md");
    if (existsSync(candidate)) return candidate;
  }
  function walk(dir, depth, atBase) {
    const entries = readdirSyncCached(dir, cache);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (atBase && entry.name === "marketplaces") continue;
      if (entry.name === "skills") {
        const candidate = join3(dir, "skills", name, "SKILL.md");
        if (existsSync(candidate)) return candidate;
        continue;
      }
      if (depth < maxDepth) {
        const found = walk(join3(dir, entry.name), depth + 1, false);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(base, 0, true);
}
function installedSkillDescription(home, name, cache = {}) {
  const direct = join3(home, ".claude/skills", name, "SKILL.md");
  if (existsSync(direct)) return descriptionFromSkillMdSync(direct);
  const found = findSkillMdSync(join3(home, ".claude/plugins"), name, 4, cache);
  return found ? descriptionFromSkillMdSync(found) : "";
}
async function walkFallback(base, maxDepth, out2) {
  async function walk(dir, depth, atBase) {
    if (depth > maxDepth) return;
    const entries = await readdirSafe(dir);
    if (entries.includes(".mcp.json") || entries.includes(".claude-plugin")) {
      out2.mcpServers.push(...await serversFromPluginRoot(dir));
    }
    for (const entry of entries) {
      if (atBase && entry === "marketplaces") continue;
      if (await isSymlink(join3(dir, entry))) continue;
      if (entry === "agents") {
        out2.agents.push(...await agentsFromPluginRoot(dir));
        continue;
      }
      if (entry === "skills") {
        out2.skills.push(...await skillsFromPluginRoot(dir));
        continue;
      }
      await walk(join3(dir, entry), depth + 1, false);
    }
  }
  await walk(base, 0, true);
}
async function readPluginInventory(home) {
  const base = join3(home, ".claude/plugins");
  const plugins = [], skills = [], agents = [], mcpServers = [];
  const index = await readJson(join3(base, "installed_plugins.json"));
  const hasIndex = !!(index && index.plugins && typeof index.plugins === "object" && !Array.isArray(index.plugins));
  const keys = hasIndex ? Object.keys(index.plugins) : [];
  const roots = [];
  for (const key of keys) {
    plugins.push(pluginName(key));
    for (const rec of Array.isArray(index.plugins[key]) ? index.plugins[key] : []) {
      if (rec && typeof rec.installPath === "string") roots.push(rec.installPath);
    }
  }
  if (roots.length) {
    for (const root of roots) {
      agents.push(...await agentsFromPluginRoot(root));
      skills.push(...await skillsFromPluginRoot(root));
      mcpServers.push(...await serversFromPluginRoot(root));
    }
  } else if (!hasIndex || keys.length) {
    await walkFallback(base, 4, { agents, skills, mcpServers });
  }
  return {
    plugins: [...new Set(plugins)],
    skills: [...new Set(skills)],
    agents: [...new Set(agents)],
    mcpServers: [...new Set(mcpServers)]
  };
}

// src/codex-inventory.js
import { execFile as execFileCb } from "node:child_process";
import { readdir as readdir4 } from "node:fs/promises";
import { join as join4 } from "node:path";
import { homedir } from "node:os";
import { promisify as promisify2 } from "node:util";
var execFileDefault = promisify2(execFileCb);
async function jsonCommand(execFile6, args) {
  try {
    const { stdout } = await execFile6("codex", args, { timeout: 1e4, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
function records(result) {
  if (Array.isArray(result)) return result;
  return result && typeof result === "object" ? [...result.installed || [], ...result.available || []] : [];
}
function installedPlugins(result) {
  const names = /* @__PURE__ */ new Set();
  return records(result).filter((plugin) => {
    if (!plugin || typeof plugin !== "object" || plugin.installed !== true || plugin.enabled !== true) return false;
    const name = plugin.name || plugin.pluginId?.split("@")[0];
    if (!name || names.has(name)) return false;
    names.add(name);
    return true;
  });
}
async function skillNames(root) {
  const names = [];
  for (const name of await readdirSafe(root)) {
    try {
      if ((await readdir4(join4(root, name))).includes("SKILL.md")) names.push(name);
    } catch {
    }
  }
  return names;
}
async function agentNames(root) {
  return (await readdirSafe(root)).filter((name) => name.endsWith(".toml")).map((name) => name.slice(0, -5));
}
function mcpNames(result) {
  if (Array.isArray(result)) return result.filter((record) => typeof record === "string" || record && typeof record === "object" && record.enabled === true).map((record) => typeof record === "string" ? record : record.name || record.server_name).filter(Boolean);
  if (!result || typeof result !== "object") return [];
  const servers = result.mcpServers || result.mcp_servers || result.servers || result;
  return Object.entries(servers).filter(([, config]) => !config || typeof config !== "object" || config.enabled !== false).map(([name]) => name);
}
async function readCodexInventory({ cwd = process.cwd(), codexHome: codexHome2 = process.env.CODEX_HOME || join4(homedir(), ".codex"), execFile: execFile6 = execFileDefault } = {}) {
  const [pluginsJson, mcpJson] = await Promise.all([
    jsonCommand(execFile6, ["plugin", "list", "--available", "--json"]),
    jsonCommand(execFile6, ["mcp", "list", "--json"])
  ]);
  const active = installedPlugins(pluginsJson);
  const pluginSkills = [], pluginAgents = [];
  for (const plugin of active) {
    if (!plugin.source?.path) continue;
    pluginSkills.push(...await skillNames(join4(plugin.source.path, "skills")));
    pluginAgents.push(...await agentNames(join4(plugin.source.path, "agents")));
  }
  const [projectSkills, userSkills, projectAgents, userAgents] = await Promise.all([
    skillNames(join4(cwd, ".codex", "skills")),
    skillNames(join4(codexHome2, "skills")),
    agentNames(join4(cwd, ".codex", "agents")),
    agentNames(join4(codexHome2, "agents"))
  ]);
  return {
    plugins: active.map((plugin) => plugin.name || plugin.pluginId.split("@")[0]),
    skills: [.../* @__PURE__ */ new Set([...pluginSkills, ...projectSkills, ...userSkills])],
    mcpServers: [...new Set(mcpNames(mcpJson))],
    agents: [.../* @__PURE__ */ new Set([...pluginAgents, ...projectAgents, ...userAgents])]
  };
}
async function codexAvailable({ execFile: execFile6 = execFileDefault } = {}) {
  try {
    await execFile6("codex", ["--version"], { timeout: 5e3 });
    return true;
  } catch {
    return false;
  }
}

// src/harness.js
async function coworkConfigDirs(home, platform = process.platform) {
  if (platform === "darwin") return [join5(home, "Library/Application Support/Claude")];
  if (platform === "win32") {
    const dirs = [];
    const packages = join5(home, "AppData/Local/Packages");
    for (const e of await readdirSafe(packages)) {
      if (e.startsWith("Claude_")) dirs.push(join5(packages, e, "LocalCache/Roaming/Claude"));
    }
    dirs.push(join5(home, "AppData/Roaming/Claude"));
    return dirs;
  }
  return [join5(home, ".config/Claude")];
}
async function readExtensionNames(extDir) {
  const names = [];
  for (const sub of await readdirSafe(extDir)) {
    const manifest = await readJson(join5(extDir, sub, "manifest.json"));
    if (manifest) names.push(manifest.name || sub);
  }
  return names;
}
async function readInstalledCowork(home, opts = {}) {
  const { platform = process.platform, declaredConnectors = [], dir } = opts;
  const dirs = dir ? [dir] : await coworkConfigDirs(home, platform);
  const discovered = [];
  for (const d of dirs) {
    const cfg = await readJson(join5(d, "claude_desktop_config.json"));
    const extNames = await readExtensionNames(join5(d, "Claude Extensions"));
    if (cfg && cfg.mcpServers || extNames.length) {
      if (cfg && cfg.mcpServers) discovered.push(...Object.keys(cfg.mcpServers));
      discovered.push(...extNames);
      break;
    }
  }
  const inv = await readPluginInventory(home);
  return {
    plugins: inv.plugins,
    skills: inv.skills,
    agents: inv.agents,
    mcpServers: [.../* @__PURE__ */ new Set([...discovered, ...inv.mcpServers, ...declaredConnectors])],
    connectorsDiscoverable: false,
    connectorsDeclared: [...new Set(declaredConnectors)]
  };
}
async function readInstalled(home) {
  const inv = await readPluginInventory(home);
  const mcpServers = [...inv.mcpServers];
  const settings = await readJson(join5(home, ".claude/settings.json"));
  if (settings && settings.mcpServers) mcpServers.push(...Object.keys(settings.mcpServers));
  const skills = [...inv.skills];
  for (const name of await readdirSafe(join5(home, ".claude/skills"))) {
    const entries = await readdirSafe(join5(home, ".claude/skills", name));
    if (entries.includes("SKILL.md")) skills.push(name);
  }
  const agents = [...inv.agents];
  for (const f of await readdirSafe(join5(home, ".claude/agents"))) {
    if (f.endsWith(".md")) agents.push(f.slice(0, -3));
  }
  return {
    plugins: inv.plugins,
    skills: [...new Set(skills)],
    mcpServers: [...new Set(mcpServers)],
    agents: [...new Set(agents)]
  };
}

// src/capabilities.js
import { homedir as homedir2 } from "node:os";

// src/model.js
var HAIKU = /* @__PURE__ */ new Set(["code-navigation", "docs-research", "research"]);
var FABLE = /* @__PURE__ */ new Set(["judge", "architecture-review", "improve", "advisor"]);
var MODEL_TIER_ORDER = ["haiku", "sonnet", "opus", "fable"];
function capTier(tier, cap = process.env.MUSTER_MAX_TIER) {
  if (!cap) return tier;
  const capIdx = MODEL_TIER_ORDER.indexOf(cap);
  if (capIdx === -1) return tier;
  const tierIdx = MODEL_TIER_ORDER.indexOf(tier);
  if (tierIdx === -1) return tier;
  return tierIdx > capIdx ? cap : tier;
}
function fableEnabled() {
  const v = process.env.MUSTER_ENABLE_FABLE;
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}
function modelForRole(role) {
  if (HAIKU.has(role)) return capTier("haiku");
  if (FABLE.has(role)) return capTier(fableEnabled() ? "fable" : fallbackModelFor("fable"));
  return capTier("sonnet");
}
var FALLBACK = { fable: "opus" };
function fallbackModelFor(model) {
  return FALLBACK[model] || model;
}
var SONNET_IDX = MODEL_TIER_ORDER.indexOf("sonnet");
function floorAtSonnet(tier) {
  if (tier === void 0) return MODEL_TIER_ORDER[SONNET_IDX];
  return MODEL_TIER_ORDER.indexOf(tier) >= SONNET_IDX ? tier : MODEL_TIER_ORDER[SONNET_IDX];
}
function maxTier(models) {
  let best = -1;
  for (const m of models) {
    const idx = MODEL_TIER_ORDER.indexOf(m);
    if (idx > best) best = idx;
  }
  return best === -1 ? void 0 : MODEL_TIER_ORDER[best];
}

// src/installed.js
function isInstalled(entry, installed) {
  if (entry.kind !== "external" || !entry.detect?.match) return false;
  const m = entry.detect.match;
  if (entry.detect.codexStrictKind) {
    return (installed.plugins || []).includes(m);
  }
  return (installed.plugins || []).includes(m) || (installed.skills || []).includes(m) || (installed.mcpServers || []).includes(m) || (installed.agents || []).includes(m);
}

// src/capabilities.js
function providerType(entry) {
  if (entry.kind === "agent") return "agent";
  if (entry.kind === "builtin") return "skill";
  const dk = entry.detect?.kind;
  if (dk === "agent") return "agent";
  if (dk === "mcp_server") return "mcp";
  return "skill";
}
function resolveCapabilities(catalog, installed, home = homedir2()) {
  const roles = {};
  for (const role of ROLES) {
    const forRole = catalog.filter((e) => e.roles.includes(role)).sort((a, b) => b.rank - a.rank);
    const chain = [];
    let chosen2 = null;
    let chosenRank = 0;
    for (const e of forRole) {
      let entry = null;
      if (e.kind === "external" && isInstalled(e, installed)) {
        entry = { id: e.id, source: "installed", kind: providerType(e) };
      } else if (e.kind === "builtin" || e.kind === "agent") {
        entry = { id: e.id, source: "builtin", kind: providerType(e) };
      }
      if (!entry) continue;
      chain.push(entry);
      if (!chosen2) {
        chosen2 = entry;
        chosenRank = entry.source === "installed" ? e.rank ?? Infinity : e.rank ?? 0;
      }
    }
    if (!chosen2) chosen2 = { id: "inline", source: "inline", kind: "inline" };
    chain.push({ id: "inline", source: "inline", kind: "inline" });
    const recommendations = [];
    for (const e of forRole) {
      if (e.kind === "external" && e.recommended && !isInstalled(e, installed) && e.rank > chosenRank) {
        recommendations.push(`install ${e.id} for ${role} \u2014 better than the ${chosen2.id} fallback`);
      }
    }
    roles[role] = { chosen: chosen2, chain, recommendations, model: modelForRole(role) };
  }
  const skills = [];
  const seen = /* @__PURE__ */ new Set();
  const skillDescriptionCache = {};
  for (const name of new Set(installed.skills || [])) {
    seen.add(name);
    skills.push({ id: name, source: "installed", description: installedSkillDescription(home, name, skillDescriptionCache) });
  }
  for (const e of catalog) {
    if (e.kind !== "builtin" || seen.has(e.id)) continue;
    seen.add(e.id);
    skills.push({ id: e.id, source: "builtin", description: e.description || "" });
  }
  return { roles, installedRaw: installed, skills };
}

// src/keyword.js
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with"
]);
function tokenize(text) {
  if (typeof text !== "string") return [];
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// src/match.js
var TOKEN_WEIGHT_HIGH = 3;
var TOKEN_WEIGHT_LOW = 1;
var INSTALLED_BOOST = 1;
var DEFAULT_LIMIT = 8;
function matchProviders(task, catalog, installed = {}, opts = {}) {
  if (typeof task !== "string" || !task.trim()) return [];
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const taskTokens = [...new Set(tokenize(task))];
  if (taskTokens.length === 0) return [];
  const results = [];
  for (const entry of catalog) {
    const bag = /* @__PURE__ */ new Map();
    const add = (token, weight) => {
      if (!token) return;
      const prev = bag.get(token) ?? 0;
      if (weight > prev) bag.set(token, weight);
    };
    for (const t of String(entry.id || "").toLowerCase().split(/[-_]+/)) add(t, TOKEN_WEIGHT_HIGH);
    for (const role of entry.roles || []) {
      for (const t of String(role).toLowerCase().split(/[-_]+/)) add(t, TOKEN_WEIGHT_HIGH);
    }
    if (Array.isArray(entry.keywords)) {
      for (const kw of entry.keywords) {
        for (const t of String(kw).toLowerCase().split(/[-_]+/)) add(t, TOKEN_WEIGHT_HIGH);
      }
    }
    if (entry.description) for (const t of tokenize(entry.description)) add(t, TOKEN_WEIGHT_LOW);
    let score = 0;
    const matched = [];
    for (const tok of taskTokens) {
      const w = bag.get(tok);
      if (w) {
        score += w;
        matched.push(tok);
      }
    }
    if (score === 0) continue;
    let source;
    if (entry.kind === "external" && isInstalled(entry, installed)) {
      source = "installed";
      score += INSTALLED_BOOST;
    } else if (entry.kind === "builtin" || entry.kind === "agent") {
      source = "builtin";
    } else {
      source = "external";
    }
    results.push({ id: entry.id, score, kind: entry.kind, source, roles: entry.roles || [], matched });
  }
  const rankOf = new Map(catalog.map((e) => [e.id, e.rank ?? 0]));
  results.sort((a, b) => b.score - a.score || (rankOf.get(b.id) ?? 0) - (rankOf.get(a.id) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return results.slice(0, limit);
}
function matchSkills(task, skills, opts = {}) {
  if (typeof task !== "string" || !task.trim()) return [];
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const taskTokens = [...new Set(tokenize(task))];
  if (taskTokens.length === 0) return [];
  const results = [];
  for (const entry of skills) {
    const bag = /* @__PURE__ */ new Map();
    const add = (token, weight) => {
      if (!token) return;
      const prev = bag.get(token) ?? 0;
      if (weight > prev) bag.set(token, weight);
    };
    for (const t of String(entry.id || "").toLowerCase().split(/[-_:]+/)) add(t, TOKEN_WEIGHT_HIGH);
    if (entry.description) for (const t of tokenize(entry.description)) add(t, TOKEN_WEIGHT_LOW);
    let score = 0;
    const matched = [];
    for (const tok of taskTokens) {
      const w = bag.get(tok);
      if (w) {
        score += w;
        matched.push(tok);
      }
    }
    if (score === 0) continue;
    if (entry.source === "installed") score += INSTALLED_BOOST;
    results.push({ id: entry.id, score, source: entry.source, matched });
  }
  results.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return results.slice(0, limit);
}
var VERCEL_NEXT_SKILLS = [
  { id: "nextjs", reason: "Next.js detected \u2014 framework-specific routing/rendering patterns" },
  { id: "shadcn", reason: "Next.js projects commonly pair with shadcn/ui components" },
  { id: "ai-sdk", reason: "Next.js projects commonly integrate the Vercel AI SDK" }
];
var DESIGN_UX_SKILLS = [
  { id: "frontend-design", reason: "user-facing UI work benefits from a dedicated frontend-design pass" },
  { id: "wsh-design-system-patterns", reason: "user-facing UI work benefits from design-system consistency" },
  { id: "wsh-responsive-design", reason: "user-facing UI work benefits from a responsive-design review" }
];
var STACK_SKILL_MAP = {
  frameworks: {
    next: VERCEL_NEXT_SKILLS,
    nextjs: VERCEL_NEXT_SKILLS,
    supabase: [
      { id: "supabase", reason: "Supabase detected as the backend/data layer" }
    ]
  },
  // Each keyword group's optional `surface` tag names the review-gate surface type
  // (see manifest.js's SURFACES) this group's skills imply -- the single source
  // impliedSurfaceForSkillId below derives its reverse lookup from, so the two can't
  // drift apart into two hand-maintained id lists.
  keywords: [
    {
      // user-facing UI work
      surface: "ui",
      triggers: ["ui", "frontend", "page", "screen", "component", "design", "layout"],
      skills: DESIGN_UX_SKILLS
    },
    {
      // customer-facing copy
      surface: "copy",
      triggers: ["copy", "content", "marketing", "brand", "branded", "messaging", "tone", "report"],
      skills: [
        { id: "muster-humanizer", reason: "customer-facing copy should pass an AI-tell humanizer review" }
      ]
    },
    {
      // integration/external-API claims
      surface: "integration",
      triggers: ["api", "integration", "webhook", "external", "thirdparty", "third-party"],
      skills: [
        { id: "sp-verify", reason: "integration/external-API claims should go through verification-before-completion" }
      ]
    }
  ]
};
function lastColonSegment(id) {
  const s = String(id ?? "");
  const i = s.lastIndexOf(":");
  return i === -1 ? s : s.slice(i + 1);
}
var SURFACE_IMPLYING_SKILL_IDS = STACK_SKILL_MAP.keywords.reduce((bySurface, group) => {
  if (!group.surface) return bySurface;
  bySurface[group.surface] = (bySurface[group.surface] || []).concat(group.skills.map((s) => s.id));
  return bySurface;
}, {});
function impliedSurfaceForSkillId(id) {
  const seg = lastColonSegment(id).toLowerCase();
  for (const [surface2, ids] of Object.entries(SURFACE_IMPLYING_SKILL_IDS)) {
    if (ids.some((i) => lastColonSegment(i).toLowerCase() === seg)) return surface2;
  }
  return null;
}
function suggestSkillsForStack(signals = {}, inventory = []) {
  const installedLastSegments = new Set(inventory.map((e) => lastColonSegment(e.id)));
  const suggestions = [];
  const seen = /* @__PURE__ */ new Set();
  const pushAll = (list) => {
    for (const s of list) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      suggestions.push({ id: s.id, reason: s.reason, missing: !installedLastSegments.has(lastColonSegment(s.id)) });
    }
  };
  for (const fw of signals.frameworks || []) {
    const list = STACK_SKILL_MAP.frameworks[String(fw).toLowerCase()];
    if (list) pushAll(list);
  }
  const kw = new Set((signals.keywords || []).map((k) => String(k).toLowerCase()));
  for (const group of STACK_SKILL_MAP.keywords) {
    if (group.triggers.some((t) => kw.has(t))) pushAll(group.skills);
  }
  return suggestions;
}
function signalsFromTask(task) {
  const tokens = [...new Set(tokenize(task))];
  return { frameworks: tokens, languages: [], keywords: tokens };
}

// src/manifest.js
var SOURCES = /* @__PURE__ */ new Set(["installed", "builtin", "dynamic", "inline"]);
var MODES = /* @__PURE__ */ new Set(["single", "tournament"]);
var MERGE_DISPOSITIONS = /* @__PURE__ */ new Set(["merge-local", "merge-push", "pr", "keep", "ask"]);
function isValidLabelArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim().length > 0);
}
var MODEL_TIERS = /* @__PURE__ */ new Set(["haiku", "sonnet", "opus", "fable"]);
var ACTION_CLASSES = /* @__PURE__ */ new Set(["send", "sign", "submit", "publish", "purchase", "delete-remote"]);
var SURFACES = /* @__PURE__ */ new Set(["ui", "copy", "integration", "none"]);
function validateSkillsArray(v, taskLabel, errors) {
  if (!Array.isArray(v)) {
    errors.push(`plan task "${taskLabel}".skills: must be an array of {id, rationale}`);
    return;
  }
  v.forEach((s, j) => {
    if (!s || typeof s !== "object") {
      errors.push(`plan task "${taskLabel}".skills[${j}]: must be an object with id and rationale`);
      return;
    }
    if (typeof s.id !== "string" || s.id.trim().length === 0)
      errors.push(`plan task "${taskLabel}".skills[${j}].id: required non-empty string`);
    if (typeof s.rationale !== "string" || s.rationale.trim().length === 0)
      errors.push(`plan task "${taskLabel}".skills[${j}].rationale: required non-empty string`);
  });
}
function validateActionArray(v, label, errors) {
  if (!Array.isArray(v)) {
    errors.push(`${label} must be an array of action-class strings`);
    return;
  }
  v.forEach((a, i) => {
    if (typeof a !== "string" || !ACTION_CLASSES.has(a)) {
      errors.push(`${label}[${i}]: unknown action class "${a}" (must be one of ${[...ACTION_CLASSES].join("|")})`);
    }
  });
}
function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== "object") return { ok: false, errors: ["manifest must be an object"] };
  if (!m.outcome || typeof m.outcome !== "string") errors.push("outcome: required non-empty string");
  if (!Array.isArray(m.successCriteria) || m.successCriteria.length === 0)
    errors.push("successCriteria: required non-empty array");
  if (!Array.isArray(m.crew) || m.crew.length === 0) errors.push("crew: required non-empty array");
  else m.crew.forEach((c, i) => {
    for (const f of ["stage", "provider", "rationale", "evidence", "fallback"])
      if (!c[f]) errors.push(`crew[${i}].${f}: required`);
    if (!SOURCES.has(c.source)) errors.push(`crew[${i}].source: must be one of ${[...SOURCES].join("|")}`);
    if (c.source !== "inline" && !c.model) errors.push(`crew[${i}].model: required for non-inline members`);
    if (c.model && !MODEL_TIERS.has(c.model)) errors.push(`crew[${i}].model: must be one of ${[...MODEL_TIERS].join("|")}`);
  });
  for (const f of ["recommendations", "degradations"])
    if (!Array.isArray(m[f])) errors.push(`${f}: must be an array`);
  if (m.mergeDisposition !== void 0 && !MERGE_DISPOSITIONS.has(m.mergeDisposition))
    errors.push(`mergeDisposition: must be one of ${[...MERGE_DISPOSITIONS].join("|")}`);
  if (m.forbiddenActions !== void 0) validateActionArray(m.forbiddenActions, "forbiddenActions", errors);
  if (!Array.isArray(m.plan) || m.plan.length === 0) errors.push("plan: required non-empty array");
  else {
    const ids = /* @__PURE__ */ new Set();
    const multi = m.plan.length > 1;
    m.plan.forEach((p, i) => {
      if (!p.task) errors.push(`plan[${i}].task: required`);
      if (!MODES.has(p.mode)) errors.push(`plan[${i}].mode: must be single|tournament`);
      if (multi && !p.id) errors.push(`plan[${i}].id: required when plan has multiple tasks`);
      if (p.id) {
        if (ids.has(p.id)) errors.push(`plan[${i}].id: duplicate id "${p.id}"`);
        ids.add(p.id);
      }
      if (p.deps !== void 0 && !Array.isArray(p.deps)) errors.push(`plan[${i}].deps: must be an array`);
      if (p.owns !== void 0 && !isValidLabelArray(p.owns))
        errors.push(`plan[${i}].owns must be an array of non-empty strings`);
      if (p.frozen !== void 0 && !isValidLabelArray(p.frozen))
        errors.push(`plan[${i}].frozen must be an array of non-empty strings`);
      if (p.forbiddenActions !== void 0) validateActionArray(p.forbiddenActions, `plan[${i}].forbiddenActions`, errors);
      const taskLabel = p.id || p.task || `plan[${i}]`;
      if (p.skills !== void 0) validateSkillsArray(p.skills, taskLabel, errors);
      if (p.surface !== void 0 && !SURFACES.has(p.surface))
        errors.push(`plan task "${taskLabel}".surface: must be one of ${[...SURFACES].join("|")}`);
    });
    m.plan.forEach((p, i) => {
      for (const d of p.deps || []) if (!ids.has(d)) errors.push(`plan[${i}].deps: unknown dep "${d}"`);
    });
  }
  return { ok: errors.length === 0, errors };
}
function manifestWarnings(m, skillsInventory) {
  const warnings = [];
  const crew = Array.isArray(m?.crew) ? m.crew : [];
  if (crew.length > 0 && crew.every((c) => c && c.source === "inline")) {
    warnings.push(
      "crew: every member is source:inline \u2014 capability resolution was likely skipped. Build the crew from `npx -y @adnova-group/muster capabilities` (builtins resolve roles like `implement -> muster-builder`); a hand-authored all-inline crew bypasses routing."
    );
  }
  const plan = Array.isArray(m?.plan) ? m.plan : [];
  const inventorySegments = Array.isArray(skillsInventory) ? new Set(skillsInventory.map((e) => lastColonSegment(String(e?.id ?? "")).toLowerCase())) : null;
  plan.forEach((p, i) => {
    if (!p || typeof p !== "object") return;
    const taskLabel = p.id || p.task || `plan[${i}]`;
    const skills = Array.isArray(p.skills) ? p.skills : [];
    if (inventorySegments) {
      skills.forEach((s, j) => {
        if (!s || typeof s.id !== "string" || !s.id.trim()) return;
        if (!inventorySegments.has(lastColonSegment(s.id).toLowerCase())) {
          warnings.push(
            `plan task "${taskLabel}".skills[${j}].id "${s.id}": not found in resolveCapabilities().skills -- likely a hallucinated or uninstalled skill id (bound skills must resolve in the live inventory).`
          );
        }
      });
    }
    if (p.surface === "none") {
      const implied = [...new Set(
        skills.map((s) => s && typeof s.id === "string" ? impliedSurfaceForSkillId(s.id) : null).filter(Boolean)
      )];
      if (implied.length > 0) {
        warnings.push(
          `plan task "${taskLabel}": binds skill(s) implying surface ${implied.join("/")} but surface is set to "none" -- the review gate's ${implied.join("/")} definition-of-done check(s) will be skipped.`
        );
      }
    }
  });
  return warnings;
}

// src/memory.js
var import_yaml2 = __toESM(require_dist(), 1);
import { readdir as readdir5, readFile as readFile3, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join as join6 } from "node:path";
async function writeMemory(dir, entry) {
  for (const field of ["slug", "title", "outcome", "body"]) {
    const v = entry?.[field];
    if (typeof v !== "string" || v.length === 0)
      throw new Error(`writeMemory: missing required field "${field}"`);
  }
  if (entry.slug.includes("/") || entry.slug.includes("\\") || entry.slug.includes(".."))
    throw new Error(`writeMemory: invalid slug "${entry.slug}" (no path separators or ..)`);
  const links = entry.links || [];
  for (const l of links) {
    if (typeof l !== "string" || l.includes("]]") || /[\n\r]/.test(l))
      throw new Error(`writeMemory: invalid link ${JSON.stringify(l)} (no "]]" or newlines)`);
  }
  await mkdir(dir, { recursive: true });
  const linkLine = links.map((l) => `[[${l}]]`).join(" ");
  const frontmatter = (0, import_yaml2.stringify)({ title: entry.title, outcome: entry.outcome }, { lineWidth: 0 }).trim();
  const md = `---
${frontmatter}
---

${entry.body}

${linkLine}
`;
  await writeFile(join6(dir, `${entry.slug}.md`), md);
  const line = `- [${entry.title}](${entry.slug}.md) \u2014 ${entry.outcome}
`;
  const indexPath = join6(dir, "INDEX.md");
  const existing = await exists(indexPath) ? await readFile3(indexPath, "utf8") : "";
  if (!existing.includes(`${entry.slug}.md`)) {
    const prefix = existing ? "" : "# Muster memory index\n\n";
    await appendFile(indexPath, prefix + line);
  }
}
async function readMemory(dir, query) {
  if (!await exists(dir)) return [];
  const files = (await readdir5(dir)).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
  const q = query.toLowerCase();
  const hits = [];
  for (const f of files) {
    const content = await readFile3(join6(dir, f), "utf8");
    if (content.toLowerCase().includes(q)) hits.push({ slug: f.replace(/\.md$/, ""), content });
  }
  return hits;
}

// src/wave.js
function computeWaves(tasks) {
  if (!Array.isArray(tasks)) throw new Error("computeWaves: tasks must be an array");
  const byId = /* @__PURE__ */ new Map();
  for (const t of tasks) {
    if (byId.has(t.id)) throw new Error(`duplicate task id "${t.id}"`);
    byId.set(t.id, t);
  }
  for (const t of tasks) for (const d of t.deps || []) {
    if (!byId.has(d)) throw new Error(`unknown dep "${d}" referenced by "${t.id}"`);
  }
  const done = /* @__PURE__ */ new Set();
  const waves = [];
  let remaining = tasks.slice();
  while (remaining.length) {
    const ready = remaining.filter((t) => (t.deps || []).every((d) => done.has(d)));
    if (ready.length === 0) {
      throw new Error(`cycle detected in task deps (unresolved: ${remaining.map((t) => t.id).join(", ")})`);
    }
    waves.push(ready);
    for (const t of ready) done.add(t.id);
    remaining = remaining.filter((t) => !done.has(t.id));
  }
  return waves;
}
function nextTasks(tasks, completed = []) {
  const waves = computeWaves(tasks);
  const waveOf = /* @__PURE__ */ new Map();
  waves.forEach((w, i) => w.forEach((t) => waveOf.set(t.id, i)));
  const ids = new Set(tasks.map((t) => t.id));
  const doneSet = new Set(completed);
  const unknownCompleted = [...doneSet].filter((id) => !ids.has(id));
  const remaining = tasks.filter((t) => !doneSet.has(t.id));
  const ready = remaining.filter((t) => (t.deps || []).every((d) => doneSet.has(d))).map((t) => ({ ...t, wave: waveOf.get(t.id) })).sort((x, y) => x.wave - y.wave);
  const blocked = remaining.filter((t) => (t.deps || []).some((d) => !doneSet.has(d))).map((t) => ({ id: t.id, missing: (t.deps || []).filter((d) => !doneSet.has(d)) }));
  return {
    done: remaining.length === 0,
    next: ready[0] || null,
    ready,
    blocked,
    remaining: remaining.length,
    ...unknownCompleted.length ? { unknownCompleted } : {}
  };
}

// src/sprint-waves.js
var CHECKBOX_RE = /^- \[ \] (.*)$/;
var CHECKED_CHECKBOX_RE = /^- \[[xX]\] (.*)$/;
var ID_TOKEN_RE = /^[a-z0-9][a-z0-9-]*$/i;
function annotationRegex() {
  return /\{\s*([A-Za-z][\w-]*)\s*:\s*([^}]*)\}/g;
}
var ANNOTATION_GROUP_SRC = "\\{\\s*[A-Za-z][\\w-]*\\s*:\\s*[^}]*\\}";
function trailingAnnotationBlockRegex() {
  return new RegExp(`(?:\\s*${ANNOTATION_GROUP_SRC})+\\s*$`);
}
function stripAnnotations(text) {
  const anns = {};
  const trailingMatch = text.match(trailingAnnotationBlockRegex());
  const bodyText = trailingMatch ? text.slice(0, trailingMatch.index) : text;
  const annotationBlock = trailingMatch ? trailingMatch[0] : "";
  const re = annotationRegex();
  let m;
  while (m = re.exec(annotationBlock)) {
    anns[m[1].toLowerCase()] = m[2].trim();
  }
  const stripped = bodyText.replace(/\s+/g, " ").trim();
  return { anns, text: stripped };
}
function computeSprintWaves(content) {
  if (typeof content !== "string") {
    return { ok: false, errors: ["missing content: expected backlog text"], waves: [], items: {}, annotated: false };
  }
  if (content.trim() === "") {
    return { ok: false, errors: ["empty backlog: no content"], waves: [], items: {}, annotated: false };
  }
  const raw = [];
  const checkedIds = /* @__PURE__ */ new Set();
  content.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.replace(/^\s+/, "");
    const lineNo = i + 1;
    const m = CHECKBOX_RE.exec(trimmed);
    if (m) {
      const { anns, text } = stripAnnotations(m[1]);
      const hasId = Object.prototype.hasOwnProperty.call(anns, "id");
      raw.push({
        lineNo,
        hasId,
        rawId: anns.id,
        id: anns.id || `item-${lineNo}`,
        text,
        hasDeps: Object.prototype.hasOwnProperty.call(anns, "deps"),
        depsRaw: anns.deps,
        disposition: Object.prototype.hasOwnProperty.call(anns, "disposition") ? anns.disposition : null,
        escalated: Object.prototype.hasOwnProperty.call(anns, "escalated"),
        claimed: Object.prototype.hasOwnProperty.call(anns, "claimed") ? anns.claimed : null
      });
      return;
    }
    const cm = CHECKED_CHECKBOX_RE.exec(trimmed);
    if (cm) {
      const { anns } = stripAnnotations(cm[1]);
      const hasId = Object.prototype.hasOwnProperty.call(anns, "id");
      checkedIds.add(hasId ? anns.id : `item-${lineNo}`);
    }
  });
  const annotated = raw.some((r) => r.hasId || r.hasDeps);
  const idErrors = raw.filter((r) => r.hasId && !ID_TOKEN_RE.test(r.rawId)).map((r) => `invalid id '${r.rawId}' at line ${r.lineNo}`);
  if (idErrors.length > 0) {
    return { ok: false, errors: idErrors, waves: [], items: {}, annotated };
  }
  const collisionErrors = [...new Set(raw.map((r) => r.id).filter((id) => checkedIds.has(id)))].map(
    (id) => `duplicate id "${id}": used by both a checked and an unchecked item`
  );
  if (collisionErrors.length > 0) {
    return { ok: false, errors: collisionErrors, waves: [], items: {}, annotated };
  }
  const idsSoFar = [];
  const tasks = raw.map((r) => {
    let deps;
    if (r.hasDeps) {
      const v = (r.depsRaw || "").trim();
      deps = v.toLowerCase() === "none" ? [] : v.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      deps = idsSoFar.slice();
    }
    deps = deps.filter((d) => !checkedIds.has(d));
    idsSoFar.push(r.id);
    return { id: r.id, deps };
  });
  const items = {};
  for (const r of raw) {
    items[r.id] = { line: r.lineNo, text: r.text, disposition: r.disposition, escalated: r.escalated, claimed: r.claimed };
  }
  try {
    const computed = computeWaves(tasks);
    return { ok: true, errors: [], waves: computed.map((w) => w.map((t) => t.id)), items, annotated };
  } catch (e) {
    return { ok: false, errors: [e.message], waves: [], items, annotated };
  }
}

// src/review.js
function tallyReview(verdicts) {
  const counts = { blocker: 0, risk: 0, nit: 0 };
  const blockers = [];
  for (const v of verdicts) {
    for (const f of v.findings || []) {
      if (counts[f.severity] !== void 0) counts[f.severity] += 1;
      if (f.severity === "blocker") blockers.push({ reviewer: v.reviewer, note: f.note });
    }
  }
  return { blocked: blockers.length > 0, blockers, counts };
}

// src/tournament.js
function pickWinner(candidates) {
  if (!Array.isArray(candidates)) return { winner: null, escalate: true, ranking: [] };
  const ranking = candidates.map((c) => ({ id: c.id, total: c.total, passing: !!c.passing })).sort((a, b) => b.total - a.total || String(a.id).localeCompare(String(b.id)));
  const passing = ranking.filter((c) => c.passing);
  if (passing.length === 0) return { winner: null, escalate: true, ranking };
  return { winner: passing[0].id, escalate: false, ranking };
}

// src/cli.js
import { homedir as homedir9 } from "node:os";
import { readFile as readFile14, writeFile as writeFile8, mkdir as mkdir7 } from "node:fs/promises";

// src/pipeline.js
var import_yaml3 = __toESM(require_dist(), 1);
import { readdir as readdir6, readFile as readFile4 } from "node:fs/promises";
import { join as join7 } from "node:path";
function validatePipeline(p) {
  const errors = [];
  if (!p || typeof p !== "object") return { ok: false, errors: ["pipeline must be an object"] };
  if (!p.id) errors.push("pipeline: id required");
  if (!p.domain) errors.push("pipeline: domain required");
  if (!Array.isArray(p.phases) || p.phases.length === 0) errors.push("pipeline: phases required");
  else p.phases.forEach((ph, i) => {
    if (!ph.id) errors.push(`pipeline.phases[${i}].id required`);
    if (!ph.role) errors.push(`pipeline.phases[${i}].role required`);
  });
  if (!p.gate || !Array.isArray(p.gate.criteria) || typeof p.gate.floor !== "number" || typeof p.gate.pass_total !== "number")
    errors.push("pipeline: gate.{criteria,floor,pass_total} required");
  return { ok: errors.length === 0, errors };
}
async function loadPipelines(dir) {
  const base = resolveDir(dir);
  const files = (await readdir6(base)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const pipelines = [];
  for (const f of files) {
    const p = (0, import_yaml3.parse)(await readFile4(join7(base, f), "utf8"));
    const { ok, errors } = validatePipeline(p);
    if (!ok) throw new Error(`Invalid pipeline ${f}:
` + errors.join("\n"));
    pipelines.push(p);
  }
  return pipelines;
}
function pipelineForDomain(pipelines, domain) {
  return pipelines.find((p) => p.domain === domain && p.default) || pipelines.find((p) => p.domain === domain) || null;
}
function pickPipeline(pipelines, outcome) {
  const text = outcome || "";
  let best = null;
  for (const p of pipelines) {
    for (const m of p.match || []) {
      const re = new RegExp(`\\b${escapeRe(m)}\\b`, "i");
      const hit = re.exec(text);
      if (!hit) continue;
      if (!best || hit.index < best.index || hit.index === best.index && m.length > best.len) {
        best = { p, index: hit.index, len: m.length };
      }
    }
  }
  return best ? best.p : null;
}
function routePipeline(pipelines, outcome, domain) {
  return pickPipeline(pipelines, outcome) || pipelineForDomain(pipelines, domain);
}

// src/domain.js
var DOMAIN_KEYWORDS = {
  pm: ["prd", "product spec", "user story", "epic", "roadmap", "prioritize", "prioritization", "requirements", "product brief"],
  business: ["business case", "investor", "pitch", "financial model", "market analysis"],
  marketing: ["lead magnet", "campaign", "landing page", "go-to-market", "gtm", "email sequence"],
  ops: ["runbook", "sop", "operations", "process doc", "incident"],
  blog: ["blog post", "blog", "article"],
  social: ["social post", "social media", "tweet", "linkedin post", "x post", "thread", "instagram caption", "reel script"],
  newsletter: ["newsletter", "email newsletter"],
  sales: ["case study", "customer story", "sales deck", "battlecard"],
  book: ["book", "novel", "manuscript", "memoir"],
  video: ["video script", "video content", "screencast", "b-roll", "shot list", "video edit", "youtube script", "video plan", "video"],
  software: ["implement", "refactor", "bug", "api", "endpoint", "function", "deploy"]
};
function knownDomains() {
  return Object.keys(DOMAIN_KEYWORDS);
}
function classifyDomain(outcome, profile = {}, override) {
  if (override) return { domain: override, source: "override", confidence: 1 };
  const text = (outcome || "").toLowerCase();
  for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
    if (kws.some((k) => new RegExp(`\\b${escapeRe(k)}\\b`, "i").test(text))) return { domain, source: "outcome", confidence: 0.8 };
  }
  if (profile.shape && profile.shape !== "unknown" && !profile.greenfield) {
    return { domain: "software", source: "workspace", confidence: 0.6 };
  }
  return { domain: "unknown", source: "none", confidence: 0 };
}

// src/doctor.js
var import_yaml4 = __toESM(require_dist(), 1);
import { readdir as readdir7, readFile as readFile5 } from "node:fs/promises";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { join as join8 } from "node:path";
import { homedir as homedir3 } from "node:os";
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var KNOWN_HOOK_EVENTS = /* @__PURE__ */ new Set([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Notification",
  "SubagentStop",
  "SessionEnd",
  "PreCompact"
]);
function extractHookFilename(command) {
  const m = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^\s"]+\.js)/);
  return m ? m[1] : null;
}
function pluginNotFoundDetail(entry) {
  return entry.reason === "no-file" ? "no installed_plugins.json \u2014 skip" : "muster not in installed_plugins.json \u2014 skip";
}
async function readMusterPluginEntry(home) {
  const effectiveHome = home || homedir3();
  const installedPath = join8(effectiveHome, ".claude/plugins/installed_plugins.json");
  const installedJson = await readJson(installedPath);
  if (!installedJson || !installedJson.plugins) return { found: false, reason: "no-file" };
  const musterKey = Object.keys(installedJson.plugins).find((k) => k.split("@")[0] === "muster");
  if (!musterKey) return { found: false, reason: "no-entry" };
  const entries = installedJson.plugins[musterKey];
  return { found: true, musterKey, entries };
}
function semverCompare(a, b) {
  const parse4 = (v) => String(v).split(".").map(Number);
  const [aMaj, aMin, aPat = 0] = parse4(a);
  const [bMaj, bMin, bPat = 0] = parse4(b);
  return aMaj - bMaj || aMin - bMin || aPat - bPat;
}
function extractDocsPaths(content) {
  const re = /`(docs\/[A-Za-z0-9/_.-]+\.[A-Za-z0-9]+)`/g;
  const refs = [];
  let m;
  while (m = re.exec(content)) {
    const before = content.slice(Math.max(0, m.index - 20), m.index);
    if (/default\s+$/i.test(before)) continue;
    refs.push({ path: m[1], index: m.index });
  }
  return refs;
}
var CREATE_ON_FIRST_USE_RE = /\bif\s+(present|it exists|[a-z0-9`/_.-]*\s*(exists|missing))\b|\bor the project'?s equivalent\b/i;
function isCreateOnFirstUseRef(content, index) {
  const before = content.slice(Math.max(0, index - 150), index);
  const window = before + content.slice(index, Math.min(content.length, index + 150));
  if (CREATE_ON_FIRST_USE_RE.test(window)) return true;
  const lastIf = before.toLowerCase().lastIndexOf("if ");
  if (lastIf === -1) return false;
  return !/[.!?,]/.test(before.slice(lastIf + 3));
}
async function vendoredBuiltinIds(base) {
  const raw = await readFile5(join8(base, "vendor/manifest.yaml"), "utf8").catch(() => null);
  const ids = /* @__PURE__ */ new Set();
  if (!raw) return ids;
  let manifest;
  try {
    manifest = (0, import_yaml4.parse)(raw);
  } catch {
    return ids;
  }
  for (const s of manifest?.sources || []) {
    for (const it of s.items || []) if (it?.id) ids.add(it.id);
  }
  return ids;
}
var SHA_TOKEN_RE = /\b[0-9a-f]{7,40}\b/gi;
function extractVendorNotes(raw, sources) {
  const notes = [];
  const headerRe = /^\s*-\s*id:\s*(\S+)/gm;
  const headers = [];
  let hm;
  while (hm = headerRe.exec(raw)) headers.push({ id: hm[1], index: hm.index });
  for (let i = 0; i < headers.length; i++) {
    const source = sources.find((s) => s.id === headers[i].id);
    if (!source || source.kind !== "github" || !source.ref || !source.repo) continue;
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : raw.length;
    const segment = raw.slice(start, end);
    const shas = /* @__PURE__ */ new Set();
    for (const line of segment.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("#")) continue;
      for (const tok of trimmed.match(SHA_TOKEN_RE) || []) shas.add(tok.toLowerCase());
    }
    for (const sha of shas) {
      if (source.ref.toLowerCase().startsWith(sha)) continue;
      notes.push({ sourceId: source.id, repo: source.repo, ref: source.ref, sha });
    }
  }
  return notes;
}
async function checkNoteAncestor(note, execImpl) {
  try {
    const { stdout } = await execImpl(
      "gh",
      ["api", `repos/${note.repo}/compare/${note.sha}...${note.ref}`, "--jq", ".status"],
      { timeout: 8e3 }
    );
    const status = String(stdout).trim();
    return { ok: status === "ahead" || status === "identical", status };
  } catch (e) {
    return { offline: true, error: e };
  }
}
async function runDoctor({ root, home, exec } = {}) {
  const base = root instanceof URL ? fileURLToPath2(root) : root || process.cwd();
  const checks = [];
  try {
    const c = await loadCatalog(join8(base, "catalog"));
    checks.push({ name: "catalog", ok: true, detail: `${c.length} entries` });
  } catch (e) {
    checks.push({ name: "catalog", ok: false, detail: e.message });
  }
  let pipelines = null;
  try {
    pipelines = await loadPipelines(join8(base, "pipelines"));
    checks.push({ name: "pipelines", ok: true, detail: `${pipelines.length} pipelines` });
  } catch (e) {
    checks.push({ name: "pipelines", ok: false, detail: e.message });
  }
  {
    if (pipelines === null) {
      checks.push({ name: "domain-alignment", ok: true, detail: "pipelines failed to load \u2014 skip" });
    } else {
      const known = new Set(knownDomains());
      const bad = pipelines.filter((p) => !known.has(p.domain)).map((p) => `${p.id} (domain: "${p.domain}")`);
      if (bad.length > 0) {
        checks.push({ name: "domain-alignment", ok: false, detail: `pipeline domain(s) not in classifier vocabulary: ${bad.join(", ")}` });
      } else {
        checks.push({ name: "domain-alignment", ok: true, detail: `${pipelines.length} pipeline domain(s) aligned` });
      }
    }
  }
  {
    try {
      const vendored = await vendoredBuiltinIds(base);
      const skillFiles = [];
      const skillsDir = join8(base, "plugin/skills");
      for (const d of await readdirSafe(skillsDir)) {
        const p = join8(skillsDir, d, "SKILL.md");
        if (await exists(p)) skillFiles.push(p);
      }
      const builtinsDir = join8(base, "plugin/builtins");
      for (const d of await readdirSafe(builtinsDir)) {
        if (vendored.has(d)) continue;
        const p = join8(builtinsDir, d, "SKILL.md");
        if (await exists(p)) skillFiles.push(p);
      }
      const missing = [];
      const conventionAbsent = [];
      for (const file of skillFiles) {
        const content = await readFile5(file, "utf8");
        for (const { path: docPath, index } of extractDocsPaths(content)) {
          if (await exists(join8(base, docPath))) continue;
          if (isCreateOnFirstUseRef(content, index)) {
            conventionAbsent.push(docPath);
          } else {
            missing.push(`${docPath} (referenced by ${file})`);
          }
        }
      }
      if (missing.length > 0) {
        checks.push({ name: "skill-doc-refs", ok: false, detail: `missing doc(s) referenced by SKILL.md: ${missing.join(", ")}` });
      } else if (conventionAbsent.length > 0) {
        checks.push({ name: "skill-doc-refs", ok: true, detail: `${skillFiles.length} skill file(s) checked \u2014 absent (created on first use): ${conventionAbsent.join(", ")}` });
      } else {
        checks.push({ name: "skill-doc-refs", ok: true, detail: `${skillFiles.length} skill file(s) checked` });
      }
    } catch (e) {
      checks.push({ name: "skill-doc-refs", ok: false, detail: e.message });
    }
  }
  const bdir = join8(base, "plugin/builtins");
  const bn = await exists(bdir) ? (await readdir7(bdir)).length : 0;
  checks.push({ name: "builtins", ok: bn > 0, detail: `${bn} built-ins` });
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node>=20", ok: major >= 20, detail: process.versions.node });
  {
    const hooksJsonPath = join8(base, "plugin/hooks/hooks.json");
    const hooksDir = join8(base, "plugin/hooks");
    const parsed = await readJson(hooksJsonPath);
    if (!parsed || typeof parsed.hooks !== "object") {
      checks.push({ name: "hooks-integrity", ok: false, detail: "hooks.json missing or malformed" });
    } else {
      const events = Object.keys(parsed.hooks);
      const badEvent = events.find((e) => !KNOWN_HOOK_EVENTS.has(e));
      if (badEvent) {
        checks.push({ name: "hooks-integrity", ok: false, detail: `unknown hook event: "${badEvent}" \u2014 expected one of ${[...KNOWN_HOOK_EVENTS].join(", ")}` });
      } else {
        const problems = [];
        for (const eventHandlers of Object.values(parsed.hooks)) {
          for (const group of eventHandlers) {
            for (const hook of group.hooks || []) {
              if (typeof hook.command === "string") {
                const fname = extractHookFilename(hook.command);
                if (fname) {
                  const fpath = join8(hooksDir, fname);
                  if (!await exists(fpath)) {
                    problems.push(fname);
                  }
                }
              }
            }
          }
        }
        if (problems.length > 0) {
          checks.push({ name: "hooks-integrity", ok: false, detail: `missing hook script(s): ${problems.join(", ")}` });
        } else {
          checks.push({ name: "hooks-integrity", ok: true, detail: `${events.length} event(s) verified` });
        }
      }
    }
  }
  const pluginEntry = await readMusterPluginEntry(home);
  {
    const manifestPath = join8(base, "plugin/.claude-plugin/plugin.json");
    const manifestJson = await readJson(manifestPath);
    const repoVersion = manifestJson?.version;
    if (!pluginEntry.found) {
      checks.push({ name: "plugin-staleness", ok: true, detail: pluginNotFoundDetail(pluginEntry) });
    } else {
      const installedVersion = Array.isArray(pluginEntry.entries) && pluginEntry.entries[0]?.version;
      if (!installedVersion || !repoVersion) {
        checks.push({ name: "plugin-staleness", ok: true, detail: "version info unavailable \u2014 skip" });
      } else if (semverCompare(installedVersion, repoVersion) < 0) {
        checks.push({
          name: "plugin-staleness",
          ok: false,
          detail: `installed muster ${installedVersion} < repo ${repoVersion} \u2014 run: /plugin marketplace update muster, /plugin update muster, then restart Claude Code`
        });
      } else {
        checks.push({ name: "plugin-staleness", ok: true, detail: `installed muster ${installedVersion} is current` });
      }
    }
  }
  {
    if (!pluginEntry.found) {
      checks.push({ name: "install-integrity", ok: true, detail: pluginNotFoundDetail(pluginEntry) });
    } else {
      const entry = Array.isArray(pluginEntry.entries) ? pluginEntry.entries[0] : null;
      const installPath = entry?.installPath;
      const remediation = `plugin cache is missing/incomplete \u2014 run: claude plugin uninstall muster@<marketplace> && claude plugin install muster@<marketplace>, then restart`;
      if (!installPath) {
        checks.push({ name: "install-integrity", ok: true, detail: "no installPath recorded \u2014 skip" });
      } else if (!await exists(installPath)) {
        checks.push({
          name: "install-integrity",
          ok: false,
          detail: `${remediation} (installPath not found: ${installPath})`
        });
      } else if (!await exists(join8(installPath, "hooks/hooks.json"))) {
        checks.push({
          name: "install-integrity",
          ok: false,
          detail: `${remediation} (hooks/hooks.json missing under: ${installPath})`
        });
      } else {
        checks.push({ name: "install-integrity", ok: true, detail: `installPath verified: ${installPath}` });
      }
    }
  }
  {
    const pkgPath = join8(base, "package.json");
    const pluginJsonPath = join8(base, "plugin/.claude-plugin/plugin.json");
    const pkgJson = await readJson(pkgPath);
    const pluginJson = await readJson(pluginJsonPath);
    const pkgVersion = pkgJson?.version;
    const pluginVersion = pluginJson?.version;
    if (!pkgVersion || !pluginVersion) {
      checks.push({ name: "version-parity", ok: true, detail: "version info unavailable \u2014 skip" });
    } else if (pkgVersion !== pluginVersion) {
      checks.push({
        name: "version-parity",
        ok: false,
        detail: `package.json version (${pkgVersion}) !== plugin.json version (${pluginVersion}) \u2014 bump both together`
      });
    } else {
      checks.push({ name: "version-parity", ok: true, detail: `both at ${pkgVersion}` });
    }
  }
  {
    const manifestPath = join8(base, "vendor/manifest.yaml");
    const raw = await readFile5(manifestPath, "utf8").catch(() => null);
    if (raw === null) {
      checks.push({ name: "vendor-note-staleness", ok: true, detail: "no vendor/manifest.yaml \u2014 skip" });
    } else {
      let manifest;
      try {
        manifest = (0, import_yaml4.parse)(raw);
      } catch {
        manifest = null;
      }
      const sources = manifest?.sources;
      if (!Array.isArray(sources)) {
        checks.push({ name: "vendor-note-staleness", ok: true, detail: "manifest unparsable \u2014 skip" });
      } else {
        const notes = extractVendorNotes(raw, sources);
        if (notes.length === 0) {
          checks.push({ name: "vendor-note-staleness", ok: true, detail: "no commit-sha notes found" });
        } else {
          const execImpl = exec || promisify3(execFile2);
          let offline = false;
          const stale = [];
          for (const note of notes) {
            const result = await checkNoteAncestor(note, execImpl);
            if (result.offline) {
              offline = true;
              break;
            }
            if (!result.ok) {
              stale.push(`${note.sourceId}: ${note.sha} is not an ancestor of pinned ref ${note.ref} (status: ${result.status})`);
            }
          }
          if (offline) {
            checks.push({ name: "vendor-note-staleness", ok: true, detail: `skipped (offline) \u2014 ${notes.length} vendor note-sha(s) unverified` });
          } else if (stale.length > 0) {
            checks.push({ name: "vendor-note-staleness", ok: false, detail: `stale vendor note(s): ${stale.join("; ")}` });
          } else {
            checks.push({ name: "vendor-note-staleness", ok: true, detail: `${notes.length} vendor note-sha(s) verified ancestors of their pin` });
          }
        }
      }
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// src/scratchpad.js
import { mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join9 } from "node:path";
async function initScratchpad(dir, runId) {
  if (typeof runId !== "string" || runId.includes("/") || runId.includes("\\") || runId.includes(".."))
    throw new Error(`initScratchpad: invalid runId ${JSON.stringify(runId)} (no path separators or ..)`);
  const sp = join9(dir, "scratchpad", runId);
  await mkdir2(sp, { recursive: true });
  const files = { "BRIEF.md": "# Brief\n", "STATE.md": "# State (append-only)\n", "FOLLOWUPS.md": "# Follow-ups\n" };
  const created = [];
  for (const [f, c] of Object.entries(files)) {
    const p = join9(sp, f);
    if (!await exists(p)) {
      await writeFile2(p, c);
      created.push(f);
    }
  }
  return { path: sp, created };
}

// src/profile.js
import { readFile as readFile6 } from "node:fs/promises";
import { join as join10 } from "node:path";
import { homedir as homedir4 } from "node:os";
async function readProfile(home = homedir4(), cwd = process.cwd()) {
  const candidates = [join10(cwd, ".muster/profile.md"), join10(home, ".claude/muster/profile.md")];
  for (const p of candidates) {
    try {
      return { found: true, path: p, content: await readFile6(p, "utf8") };
    } catch {
    }
  }
  return { found: false, path: null, content: "" };
}

// src/signals.js
function buildSignals(profile, capabilities) {
  const roles = {};
  for (const [role, r] of Object.entries(capabilities.roles || {})) {
    roles[role] = { chosen: r.chosen, model: r.model };
  }
  return { profile, roles };
}

// src/vendor.js
var import_yaml5 = __toESM(require_dist(), 1);
import { readFile as readFile7, writeFile as writeFile3, mkdir as mkdir3, readdir as readdir8 } from "node:fs/promises";
import { join as join11, dirname as dirname2, sep } from "node:path";
import { homedir as homedir5, tmpdir } from "node:os";
import { execFile as execFile3 } from "node:child_process";
import { promisify as promisify4 } from "node:util";
var ALLOWED_TOOLS = /* @__PURE__ */ new Set([
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "Bash",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "NotebookRead",
  "KillShell",
  "BashOutput"
]);
var DEFAULT_TOOLS = "Read, Grep, Glob, Edit, Bash";
var ID_RE = /^[a-zA-Z0-9_-]+$/;
var REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
var REF_RE = /^[A-Za-z0-9_.\/~^-]+$/;
function validateVendorManifest(doc) {
  const errors = [];
  if (!doc || !Array.isArray(doc.sources)) return { ok: false, errors: ["manifest.sources must be an array"] };
  doc.sources.forEach((s, i) => {
    if (!s.id) {
      errors.push(`sources[${i}].id: required`);
    } else if (!ID_RE.test(s.id)) {
      errors.push(`sources[${i}].id: invalid \u2014 must match /^[a-zA-Z0-9_-]+$/`);
    }
    if (!s.license) errors.push(`sources[${i}].license: required`);
    if (!["local", "github"].includes(s.kind)) errors.push(`sources[${i}].kind: must be local|github`);
    if (s.repo !== void 0 && !REPO_RE.test(s.repo))
      errors.push(`sources[${i}].repo: invalid \u2014 must be owner/name (alphanumeric, dash, dot, underscore only)`);
    if (s.ref !== void 0) {
      if (!REF_RE.test(s.ref) || s.ref.startsWith("-"))
        errors.push(`sources[${i}].ref: invalid \u2014 must not start with "-" and may only contain alphanumeric, _./${String.fromCharCode(126)}^- chars`);
    }
    if (!Array.isArray(s.items)) errors.push(`sources[${i}].items: must be an array`);
    else s.items.forEach((it, j) => {
      if (!it.from) errors.push(`sources[${i}].items[${j}].from: required`);
      if (!it.id) {
        errors.push(`sources[${i}].items[${j}].id: required`);
      } else if (!ID_RE.test(it.id)) {
        errors.push(`sources[${i}].items[${j}].id: invalid \u2014 must match /^[a-zA-Z0-9_-]+$/`);
      }
      if (!Array.isArray(it.roles) || it.roles.length === 0)
        errors.push(`sources[${i}].items[${j}].roles: required non-empty array`);
      if (it.as !== void 0 && it.as !== "agent" && it.as !== "skill")
        errors.push(`sources[${i}].items[${j}].as: must be "agent" or "skill" when set`);
    });
  });
  return { ok: errors.length === 0, errors };
}
function splitFrontmatter(text) {
  const m = matchFrontmatter(text);
  if (!m) return { data: {}, body: text };
  return { data: (0, import_yaml5.parse)(m.body) || {}, body: m.rest };
}
function toBuiltin(sourceText, item, source) {
  const { data, body } = splitFrontmatter(sourceText);
  const adapted_from = `${source.repo} ${item.from}`;
  const fm = {
    name: data.name || item.id,
    description: item.description || data.description || `Built-in for ${item.roles.join(", ")} (adapted from ${source.repo})`,
    muster_builtin: true,
    adapted_from,
    license: source.license
  };
  const content = `---
${(0, import_yaml5.stringify)(fm, { lineWidth: 0 }).trim()}
---

${body.trim()}
`;
  const catalogEntry = {
    id: item.id,
    kind: "builtin",
    roles: item.roles,
    rank: item.rank !== void 0 ? item.rank : 50,
    provenance: { adapted_from, license: source.license }
  };
  if (item.description) catalogEntry.description = item.description;
  return {
    path: `plugin/builtins/${item.id}/SKILL.md`,
    content,
    catalogEntry
  };
}
function modelForRoles(roles) {
  return floorAtSonnet(maxTier(roles.map(modelForRole)));
}
function toAgent(sourceText, item, source) {
  const { data, body } = splitFrontmatter(sourceText);
  const adapted_from = `${source.repo} ${item.from}`;
  const model = item.model || modelForRoles(item.roles);
  const filteredTools = (() => {
    if (!data.tools) return DEFAULT_TOOLS;
    const allowed = data.tools.split(",").map((s) => s.trim()).filter((t) => ALLOWED_TOOLS.has(t));
    return allowed.length > 0 ? allowed.join(", ") : DEFAULT_TOOLS;
  })();
  const fm = {
    name: data.name || item.id,
    description: data.description || `Agent for ${item.roles.join(", ")} (adapted from ${source.repo})`,
    model,
    tools: filteredTools,
    muster_builtin: true,
    adapted_from,
    license: source.license
  };
  const content = `---
${(0, import_yaml5.stringify)(fm, { lineWidth: 0 }).trim()}
---

${body.trim()}
`;
  return {
    path: `plugin/agents/${item.id}.md`,
    content,
    catalogEntry: {
      id: item.id,
      kind: "agent",
      roles: item.roles,
      rank: 50,
      description: fm.description,
      provenance: { adapted_from, license: source.license }
    }
  };
}
var BANNER_TEXT = "GENERATED by `muster vendor` from vendor/manifest.yaml \u2014 do not edit";
var YAML_BANNER = `# ${BANNER_TEXT}
`;
function generateNotice(builtinEntries) {
  const bySrc = /* @__PURE__ */ new Map();
  for (const e of builtinEntries) {
    const repo = e.provenance.adapted_from.split(" ")[0];
    if (!bySrc.has(repo)) bySrc.set(repo, e.provenance.license);
  }
  let out2 = `${BANNER_TEXT}

Muster
Copyright 2026 Adnova Group

This product bundles adapted content from:
`;
  for (const [repo, lic] of bySrc) out2 += `
- ${repo} (${lic})`;
  return out2 + "\n";
}
var pexec2 = promisify4(execFile3);
var SEMVER_RE = /^\d+\.\d+\.\d+$/;
var SHA_RE = /^[0-9a-f]{40}$/i;
function cloneCommandsFor(source, dir) {
  const url = source.url || `https://github.com/${source.repo}.git`;
  const ref = source.ref || "main";
  if (SHA_RE.test(ref)) {
    return [
      ["git", ["init", dir]],
      ["git", ["-C", dir, "remote", "add", "origin", url]],
      ["git", ["-C", dir, "fetch", "--depth", "1", "origin", ref]],
      ["git", ["-C", dir, "checkout", "FETCH_HEAD"]]
    ];
  }
  return [
    ["git", ["clone", "--depth", "1", "--branch", ref, url, dir]]
  ];
}
function pickLatestVersion(entries) {
  if (!entries || entries.length === 0) return void 0;
  const semvers = entries.filter((e) => SEMVER_RE.test(e));
  if (semvers.length === 0) return entries[0];
  return semvers.reduce((best, cur) => {
    const [bMaj, bMin, bPat] = best.split(".").map(Number);
    const [cMaj, cMin, cPat] = cur.split(".").map(Number);
    if (cMaj !== bMaj) return cMaj > bMaj ? cur : best;
    if (cMin !== bMin) return cMin > bMin ? cur : best;
    return cPat > bPat ? cur : best;
  });
}
async function resolveSuperpowers(home) {
  const base = join11(home, ".claude/plugins/cache/claude-plugins-official/superpowers");
  if (!await exists(base)) return null;
  const entries = await readdir8(base);
  const best = pickLatestVersion(entries);
  const versions = best ? [best, ...entries.filter((e) => e !== best)] : entries;
  for (const v of versions) {
    const skills = join11(base, v, "skills");
    if (await exists(skills)) return skills;
  }
  return null;
}
async function fetchSourceRoot(source, home) {
  if (source.kind === "local") {
    if (source.id === "superpowers") return { root: await resolveSuperpowers(home) };
    return { root: null };
  }
  const vendorBase = join11(tmpdir(), "muster-vendor-");
  const dir = join11(tmpdir(), `muster-vendor-${source.id}`);
  if (!dir.startsWith(vendorBase)) {
    return { root: null, error: new Error(`source.id "${source.id}" would escape vendor tmp dir`) };
  }
  try {
    await pexec2("rm", ["-rf", dir]);
    for (const [cmd, args] of cloneCommandsFor(source, dir)) {
      await pexec2(cmd, args);
    }
    return { root: dir };
  } catch (e) {
    return { root: null, error: e };
  }
}
async function runVendor({ home = homedir5(), repoRoot = process.cwd(), manifest } = {}) {
  const warnings = [];
  const builtinEntries = [];
  const agentEntries = [];
  for (const source of manifest.sources) {
    const { root, error } = await fetchSourceRoot(source, home);
    if (!root) {
      const detail = error ? `: ${error.message}` : "";
      warnings.push(`source ${source.id}: could not fetch (${source.kind})${detail}`);
      continue;
    }
    for (const item of source.items) {
      const srcPath = join11(root, item.from);
      if (srcPath !== root && !srcPath.startsWith(root + sep)) {
        warnings.push(`${source.id}: item ${item.from} is outside of source root \u2014 skipping (traversal attempt)`);
        continue;
      }
      if (!await exists(srcPath)) {
        warnings.push(`${source.id}: missing item ${item.from}`);
        continue;
      }
      const text = await readFile7(srcPath, "utf8");
      const isAgent = item.as === "agent";
      const { path, content, catalogEntry } = isAgent ? toAgent(text, item, source) : toBuiltin(text, item, source);
      const abs = join11(repoRoot, path);
      if (!abs.startsWith(repoRoot + sep)) {
        warnings.push(`${source.id}: item.id "${item.id}" would write outside repoRoot \u2014 skipping`);
        continue;
      }
      await mkdir3(dirname2(abs), { recursive: true });
      await writeFile3(abs, content);
      (isAgent ? agentEntries : builtinEntries).push(catalogEntry);
    }
  }
  const allEntries = [...builtinEntries, ...agentEntries];
  if (allEntries.length === 0) {
    return { count: 0, warnings: [...warnings, "no items vendored \u2014 refusing to overwrite NOTICE/builtins.generated.yaml"] };
  }
  if (builtinEntries.length > 0)
    await writeFile3(join11(repoRoot, "catalog/builtins.generated.yaml"), YAML_BANNER + (0, import_yaml5.stringify)(builtinEntries, { lineWidth: 0 }));
  if (agentEntries.length > 0)
    await writeFile3(join11(repoRoot, "catalog/agents.generated.yaml"), YAML_BANNER + (0, import_yaml5.stringify)(agentEntries, { lineWidth: 0 }));
  await writeFile3(join11(repoRoot, "NOTICE"), generateNotice(allEntries));
  return { count: allEntries.length, builtins: builtinEntries.length, agents: agentEntries.length, warnings };
}

// src/cli.js
var import_yaml6 = __toESM(require_dist(), 1);

// src/setup.js
import { mkdir as mkdir4, writeFile as writeFile4 } from "node:fs/promises";
import { join as join12, dirname as dirname3 } from "node:path";
import { execFile as execFile4 } from "node:child_process";
import { promisify as promisify5 } from "node:util";
var pexec3 = promisify5(execFile4);
var SEEDS = {
  ".gitignore": "node_modules/\n.muster/\n*.log\n",
  "docs/design/.gitkeep": "",
  "docs/plan/.gitkeep": "",
  "README.md": "# Project\n\nScaffolded by muster.\n",
  "AGENTS.md": "# Agents\n\nThis repository is managed with muster.\n"
};
async function scaffoldProject(dir) {
  const created = [], skipped = [];
  if (!await exists(join12(dir, ".git"))) {
    try {
      await pexec3("git", ["init", "-q"], { cwd: dir });
      created.push(".git");
    } catch {
      skipped.push(".git (git unavailable)");
    }
  } else skipped.push(".git");
  for (const [rel, content] of Object.entries(SEEDS)) {
    const abs = join12(dir, rel);
    if (await exists(abs)) {
      skipped.push(rel);
      continue;
    }
    await mkdir4(dirname3(abs), { recursive: true });
    await writeFile4(abs, content);
    created.push(rel);
  }
  return { created, skipped };
}

// src/checklist.js
function fenceSuffix(t) {
  const parts = [];
  if (Array.isArray(t.owns) && t.owns.length > 0) parts.push(`owns: ${t.owns.join(", ")}`);
  if (Array.isArray(t.frozen) && t.frozen.length > 0) parts.push(`frozen: ${t.frozen.join(", ")}`);
  return parts.length > 0 ? ` [${parts.join(" | ")}]` : "";
}
function renderPlanChecklist(plan, doneIds = []) {
  const done = new Set(doneIds);
  return plan.map((t) => `- [${done.has(t.id) ? "x" : " "}] ${t.id} \u2014 ${t.task}${t.mode === "tournament" ? " (tournament)" : ""}${fenceSuffix(t)}`).join("\n");
}

// src/score.js
function scoreArtifact(scores, gate = {}) {
  const entries = Object.entries(scores || {});
  for (const [c, v] of entries) {
    if (typeof v !== "number" || !Number.isFinite(v))
      throw new Error(`scoreArtifact: score for "${c}" must be a finite number, got ${v}`);
  }
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let weakest = { criterion: null, value: entries.length ? Infinity : 0 };
  for (const [c, v] of entries) if (v < weakest.value) weakest = { criterion: c, value: v };
  const passing = entries.length > 0 && weakest.value >= (gate.floor ?? 0) && total >= (gate.pass_total ?? 0);
  return { total, weakest, passing };
}

// src/crew.js
function getRoleEntry(caps, role) {
  return caps && caps.roles && caps.roles[role];
}
function modelFor(caps, role) {
  const entry = getRoleEntry(caps, role);
  return entry && entry.model || modelForRole(role);
}
function chosen(caps, role) {
  const entry = getRoleEntry(caps, role);
  return entry && entry.chosen || { id: "inline", source: "inline" };
}
function collectRecommendations(caps, roles) {
  const recs = [];
  for (const r of roles) {
    const entry = getRoleEntry(caps, r);
    for (const rec of entry && entry.recommendations || [])
      if (!recs.includes(rec)) recs.push(rec);
  }
  return recs;
}
function makeStage(caps, evidence) {
  return (role, rationale) => {
    const p = chosen(caps, role);
    return { stage: role, provider: p.id, source: p.source, model: modelFor(caps, role), rationale, evidence, fallback: "inline" };
  };
}

// src/diagnose.js
var CI_PATTERNS = [/\bFAIL\b/, /✗/, /Error:/, /\bassert/i, /exit code [1-9]/, /\bat .+:\d+/];
function classifyFailure(input, opts = {}) {
  if (!input || !input.trim()) throw new Error("diagnose: empty failure input");
  const isCi = !!opts.ci || CI_PATTERNS.some((re) => re.test(input));
  const firstLine = input.split("\n").map((s) => s.trim()).filter(Boolean)[0] || input.trim();
  return { mode: isCi ? "ci" : "bug", signal: firstLine.slice(0, 200) };
}
function buildDiagnoseManifest(failure, caps = {}) {
  const stage = makeStage(caps, `failure: ${failure.signal}`);
  const recs = collectRecommendations(caps, ["debug", "implement", "test-author", "code-review"]);
  return {
    outcome: `Resolve: ${failure.signal}`,
    successCriteria: ["root cause identified", "fix applied", "regression test added", "suite green"],
    crew: [
      stage("debug", "systematic root-cause analysis"),
      stage("implement", "apply the minimal fix"),
      stage("test-author", "add a regression test"),
      stage("code-review", "review + verify the suite")
    ],
    recommendations: recs,
    degradations: [],
    plan: [
      { id: "repro", task: `reproduce: ${failure.signal}`, mode: "single", deps: [] },
      { id: "root-cause", task: "find root cause (hypothesis -> cheapest test -> root cause)", mode: "single", deps: ["repro"] },
      { id: "fix", task: "apply the minimal fix", mode: "single", deps: ["root-cause"] },
      { id: "regression", task: "add a regression test", mode: "single", deps: ["fix"] },
      { id: "verify", task: "review + run the suite", mode: "single", deps: ["regression"] }
    ]
  };
}

// src/audit.js
var AUDIT_DIMENSIONS = [
  { id: "architecture", role: "architecture-review", focus: "system architecture, boundaries, coupling" },
  { id: "tech-debt", role: "tech-debt", focus: "tech debt, dead code, outdated patterns" },
  { id: "coverage", role: "test-author", focus: "test coverage gaps, untested paths" },
  { id: "simplification", role: "refactor", focus: "simplification, reuse, duplication" },
  { id: "readability", role: "code-review", focus: "human readability, maintainability" },
  { id: "security", role: "security-review", focus: "security audit (injection, secrets, unsafe IO)" }
];
var PROMPT_DIMENSION = {
  id: "prompt-quality",
  role: "prompt-quality",
  focus: "prompt structure + agent/tool-prompt quality (run `muster prompt scan` to find and lint repo prompts)"
};
function buildAuditManifest(caps = {}, opts = {}) {
  const stage = makeStage(caps, "whole-codebase review");
  const dimensions = opts.prompting ? [...AUDIT_DIMENSIONS, PROMPT_DIMENSION] : AUDIT_DIMENSIONS;
  const crew = dimensions.map((d) => stage(d.role, `audit: ${d.focus}`));
  crew.push(stage("implement", "audit: remediate findings"));
  crew.push(stage("code-review", "audit: review-gate + verify"));
  const recs = collectRecommendations(caps, dimensions.map((d) => d.role));
  const auditTasks = dimensions.map((d) => ({
    id: `audit-${d.id}`,
    task: `audit ${d.focus} (read-only; findings: severity/location/problem/fix)`,
    mode: "single",
    deps: []
  }));
  return {
    outcome: "Audit + remediate the codebase",
    successCriteria: [
      "findings ledger across all dimensions",
      "every issue fixed or explicitly deferred with reason",
      "regression tests added for behavior fixes",
      "full suite green",
      "no regressions introduced"
    ],
    crew,
    recommendations: recs,
    degradations: [],
    plan: [
      ...auditTasks,
      { id: "consolidate", task: "dedupe + rank all findings into one ledger", mode: "single", deps: auditTasks.map((t) => t.id) },
      { id: "fix", task: "remediate all findings (TDD: failing test first where behavior changes); defer only with written reason", mode: "single", deps: ["consolidate"] },
      { id: "verify", task: "review-gate + full suite green; confirm no regressions", mode: "single", deps: ["fix"] }
    ]
  };
}

// src/install.js
import { readFile as readFile8, writeFile as writeFile5, rm } from "node:fs/promises";
import { join as join13 } from "node:path";
import { homedir as homedir6 } from "node:os";
import { fileURLToPath as fileURLToPath3 } from "node:url";
async function readIfExists(p) {
  try {
    return await readFile8(p, "utf8");
  } catch {
    return null;
  }
}
function resolveNames(marketplaceJson) {
  let mpName = "muster", pName = "muster";
  if (marketplaceJson) {
    try {
      const mp = JSON.parse(marketplaceJson);
      if (mp.name) mpName = mp.name;
      if (mp.plugins?.[0]?.name) pName = mp.plugins[0].name;
    } catch {
    }
  }
  return { mpName, pName };
}
function isEphemeralNpx(root) {
  const normalised = root.replace(/\\/g, "/");
  return normalised.includes("/_npx/");
}
var GITHUB_SLUG = "Adnova-Group/muster";
async function runInstall({ home = homedir6(), repoRoot } = {}) {
  const root = repoRoot || fileURLToPath3(new URL("../", import.meta.url));
  const nextSteps = [];
  if (isEphemeralNpx(root)) {
    nextSteps.push(`add the marketplace: /plugin marketplace add ${GITHUB_SLUG}`);
    nextSteps.push(`install the plugin: /plugin install muster@muster`);
  } else {
    const marketplace = await readIfExists(join13(root, ".claude-plugin", "marketplace.json"));
    if (marketplace) {
      const { mpName, pName } = resolveNames(marketplace);
      nextSteps.push(`add the marketplace: /plugin marketplace add ${root}`);
      nextSteps.push(`install the plugin: /plugin install ${pName}@${mpName}`);
    } else {
      nextSteps.push(`add the marketplace: /plugin marketplace add ${GITHUB_SLUG}`);
      nextSteps.push(`install the plugin: /plugin install muster@muster`);
    }
  }
  return {
    outputStyle: { source: "plugin", autoApplied: true, name: "Muster" },
    nextSteps
  };
}
async function runUninstall({ home = homedir6() } = {}) {
  const dest = join13(home, ".claude", "output-styles", "muster.md");
  const bak = `${dest}.bak`;
  const existing = await readIfExists(dest);
  let legacyStyle;
  if (existing === null) {
    legacyStyle = "absent";
  } else {
    const backup = await readIfExists(bak);
    if (backup !== null) {
      await writeFile5(dest, backup, "utf8");
      await rm(bak);
      legacyStyle = "restored";
    } else {
      await rm(dest);
      legacyStyle = "removed";
    }
  }
  const nextSteps = [
    `uninstall the plugin: /plugin uninstall muster@muster`,
    `remove the marketplace: /plugin marketplace remove muster`
  ];
  return { outputStyle: { legacyStyle, dest }, nextSteps };
}

// src/codex-install.js
import { cp, mkdir as mkdir6, readFile as readFile10, rm as rm3, rmdir, writeFile as writeFile7 } from "node:fs/promises";
import { basename, dirname as dirname4, isAbsolute as isAbsolute2, join as join15, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";
import { homedir as homedir7 } from "node:os";
import { fileURLToPath as fileURLToPath4 } from "node:url";
import { execFile as execFileCb2 } from "node:child_process";
import { promisify as promisify6 } from "node:util";

// src/codex-release.js
import { createHash } from "node:crypto";
import { lstat as lstat2, mkdir as mkdir5, open, readFile as readFile9, readdir as readdir9, rename, rm as rm2, writeFile as writeFile6 } from "node:fs/promises";
import { isAbsolute, join as join14, relative, resolve, win32 } from "node:path";
var RELEASE_FORMAT = 1;
var GENERATION = /^[a-f0-9]{64}$/;
var slash = (value) => value.replaceAll("\\", "/");
var sha256 = (value) => createHash("sha256").update(value).digest("hex");
function contained(base, target, label) {
  const rel = relative(resolve(base), resolve(target));
  if (!rel || rel === ".") return;
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} is not contained by ${base}: ${target}`);
  }
}
async function ordinary(path, expected, label) {
  let stat2;
  try {
    stat2 = await lstat2(path);
  } catch (error) {
    throw new Error(`${label} is missing: ${path}`, { cause: error });
  }
  if (stat2.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (expected === "directory" ? !stat2.isDirectory() : !stat2.isFile()) {
    throw new Error(`${label} must be a regular ${expected}: ${path}`);
  }
  return stat2;
}
async function assertRegularTree(root) {
  await ordinary(root, "directory", "tree root");
  const files = [], dirs = [];
  async function walk(dir) {
    const entries = await readdir9(dir);
    entries.sort();
    for (const name of entries) {
      const path = join14(dir, name);
      contained(root, path, "tree entry");
      const stat2 = await lstat2(path);
      if (stat2.isSymbolicLink()) throw new Error(`tree entry must not be a symlink: ${path}`);
      const rel = slash(relative(root, path));
      if (stat2.isDirectory()) {
        dirs.push(rel);
        await walk(path);
      } else if (stat2.isFile()) {
        const content = await readFile9(path);
        files.push({ path: rel, sha256: sha256(content), size: content.length });
      } else throw new Error(`tree entry must be a regular file or directory: ${path}`);
    }
  }
  await walk(root);
  return { dirs, files };
}
function metadataFor(packageVersion, files) {
  if (typeof packageVersion !== "string" || !packageVersion.trim()) throw new Error("release package version is required");
  const payload = { format: RELEASE_FORMAT, packageVersion, files };
  return { ...payload, generation: sha256(JSON.stringify(payload)) };
}
async function createCodexReleaseMetadata(releaseRoot, packageVersion) {
  const tree = await assertRegularTree(releaseRoot);
  if (!tree.dirs.includes("plugin") || !tree.dirs.includes("profiles")) throw new Error("release must contain plugin and profiles directories");
  const files = tree.files.filter((file) => file.path !== "release.json");
  if (!files.some((file) => file.path.startsWith("plugin/")) || !files.some((file) => file.path.startsWith("profiles/"))) {
    throw new Error("release plugin and profiles must both contain regular files");
  }
  return metadataFor(packageVersion, files);
}
async function validateCodexRelease(releaseRoot, expectedGeneration) {
  await ordinary(join14(releaseRoot, "release.json"), "file", "release metadata");
  let metadata;
  try {
    metadata = JSON.parse(await readFile9(join14(releaseRoot, "release.json"), "utf8"));
  } catch (error) {
    throw new Error(`release metadata is invalid: ${releaseRoot}`, { cause: error });
  }
  if (metadata?.format !== RELEASE_FORMAT || !GENERATION.test(metadata.generation || "") || !Array.isArray(metadata.files)) {
    throw new Error(`release metadata has an invalid contract: ${releaseRoot}`);
  }
  if (expectedGeneration && metadata.generation !== expectedGeneration) throw new Error("release generation does not match the selected pointer");
  if (releaseRoot.split(/[\\/]/).at(-1) !== metadata.generation) throw new Error("release directory is not content-addressed by its generation");
  const actual = await createCodexReleaseMetadata(releaseRoot, metadata.packageVersion);
  if (actual.generation !== metadata.generation || JSON.stringify(actual.files) !== JSON.stringify(metadata.files)) {
    throw new Error(`release content hash mismatch: ${releaseRoot}`);
  }
  return metadata;
}
function pointerRelative(value, label) {
  if (typeof value !== "string" || !value.startsWith("./") || value.includes("\\") || win32.isAbsolute(value)) {
    throw new Error(`${label} must be a forward-slash relative release pointer`);
  }
  const parts = value.slice(2).split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) throw new Error(`${label} is not a contained release pointer`);
  return parts;
}
async function readPointer(repoRoot) {
  const path = join14(repoRoot, ".agents", "plugins", "marketplace.json");
  await ordinary(path, "file", "Codex marketplace pointer");
  let pointer;
  try {
    pointer = JSON.parse(await readFile9(path, "utf8"));
  } catch (error) {
    throw new Error("Codex marketplace pointer is invalid JSON", { cause: error });
  }
  return { path, pointer };
}
async function resolveCodexRelease(repoRoot) {
  const { pointer } = await readPointer(repoRoot);
  const selected = pointer?.musterRelease;
  const pluginPath = pointer?.plugins?.find((plugin) => plugin?.name === "muster")?.source?.path;
  if (selected?.format !== RELEASE_FORMAT || !GENERATION.test(selected?.generation || "")) throw new Error("Codex marketplace is missing a valid Muster release pointer");
  const base = `.agents/plugins/releases/${selected.generation}`;
  const expected = {
    plugin: `./${base}/plugin`,
    profiles: `./${base}/profiles`,
    metadata: `./${base}/release.json`
  };
  for (const [label, value] of Object.entries({ plugin: pluginPath, profiles: selected.profiles, metadata: selected.metadata })) {
    pointerRelative(value, `${label} path`);
    if (value !== expected[label]) throw new Error(`${label} path does not match the selected release pointer`);
  }
  const releaseRoot = join14(repoRoot, ...base.split("/"));
  contained(repoRoot, releaseRoot, "selected release");
  const metadata = await validateCodexRelease(releaseRoot, selected.generation);
  return {
    generation: selected.generation,
    releaseRoot,
    pluginRoot: join14(releaseRoot, "plugin"),
    profilesRoot: join14(releaseRoot, "profiles"),
    metadata
  };
}

// src/codex-install.js
var execFileDefault2 = promisify6(execFileCb2);
var CODEX_MARKETPLACE = "Adnova-Group/muster";
var CODEX_PLUGIN = "muster@muster";
var CODEX_MARKETPLACE_URL = "https://github.com/Adnova-Group/muster.git";
var MANIFEST = ".muster-managed.json";
var PROFILE_FILENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.toml$/;
var HOOK_FILES = ["hooks/muster-hook.mjs", "hooks/action-guard.mjs"];
var codexHome = (home) => process.env.CODEX_HOME || join15(home, ".codex");
var agentsDir = (scope, cwd, home) => scope === "user" ? join15(codexHome(home), "agents") : join15(cwd, ".codex", "agents");
var configDir = (scope, cwd, home) => scope === "user" ? codexHome(home) : join15(cwd, ".codex");
var readJson2 = async (path) => {
  try {
    return JSON.parse(await readFile10(path, "utf8"));
  } catch {
    return null;
  }
};
var profileFiles = async (root) => (await readdirSafe(root)).filter((name) => name.endsWith(".toml")).sort();
var run = (execFile6, args) => execFile6("codex", args, { timeout: 3e4, maxBuffer: 4 * 1024 * 1024 });
async function runJson(execFile6, args) {
  return JSON.parse((await run(execFile6, args)).stdout);
}
function validateManagedFiles(manifest, dir, manifestPath) {
  if (manifest?.owner !== "muster" || manifest.format !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`Codex installation manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  const base = resolve2(dir), seen = /* @__PURE__ */ new Set();
  for (const file of manifest.files) {
    const destination = typeof file === "string" ? resolve2(base, file) : "";
    if (typeof file !== "string" || file !== basename(file) || dirname4(destination) !== base || !PROFILE_FILENAME.test(file) || seen.has(file)) {
      throw new Error(`Invalid Muster-owned Codex profile in ${manifestPath}: ${JSON.stringify(file)}. Remove the invalid manifest before retrying.`);
    }
    seen.add(file);
  }
  return [...seen];
}
function validateHookManifest(manifest, dir, manifestPath) {
  if (manifest?.owner !== "muster" || manifest.format !== 1 || !Array.isArray(manifest.files) || typeof manifest.hookGroups !== "object" || !manifest.hookGroups) {
    throw new Error(`Codex hook installation manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  const base = resolve2(dir), seen = /* @__PURE__ */ new Set();
  for (const file of manifest.files) {
    const destination = typeof file === "string" ? resolve2(base, file) : "";
    const rel = destination ? relative2(base, destination) : "";
    if (typeof file !== "string" || !file || isAbsolute2(file) || rel === ".." || rel.startsWith(`..${sep2}`) || seen.has(file)) {
      throw new Error(`Invalid Muster-owned Codex hook runtime in ${manifestPath}: ${JSON.stringify(file)}. Remove the invalid manifest before retrying.`);
    }
    seen.add(file);
  }
  return { files: [...seen], hookGroups: manifest.hookGroups, hookConfigCreated: manifest.hookConfigCreated === true };
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
var same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
var groupCommands = (group) => (group?.hooks || []).flatMap((hook) => [hook?.command, hook?.commandWindows, hook?.command_windows]).filter(Boolean);
var isMusterHookCommand = (command) => typeof command === "string" && command.replaceAll("\\", "/").includes("/muster/hooks/muster-hook.mjs");
function removeOwnedHookGroups(config, owned, configPath) {
  const next = clone(config);
  next.hooks ||= {};
  for (const [event, groups] of Object.entries(owned || {})) {
    if (!Array.isArray(groups)) throw new Error(`Invalid Muster-owned Codex hook groups in ${configPath}: ${event}`);
    const current = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    for (const group of groups) {
      const exact = current.findIndex((candidate) => same(candidate, group));
      if (exact >= 0) current.splice(exact, 1);
      else if (current.some((candidate) => groupCommands(candidate).some((command) => groupCommands(group).includes(command)))) {
        throw new Error(`Codex hook conflict: a Muster-owned hook was modified in ${configPath}. Restore it or remove the Muster hook manifest before retrying.`);
      }
    }
    if (current.length) next.hooks[event] = current;
    else delete next.hooks[event];
  }
  return next;
}
function shellCommand(path) {
  if (/[\r\n\0]/.test(path)) throw new Error(`Codex hook path contains unsupported control characters: ${path}`);
  const posix = `'${path.replaceAll("'", `'\\''`)}'`;
  const windows = path.replaceAll("\\", "/").replaceAll('"', '\\"');
  return { command: `node ${posix}`, commandWindows: `node "${windows}"` };
}
async function prepareHooks({ scope, cwd, home, root }) {
  const dir = configDir(scope, cwd, home);
  const runtimeDir = join15(dir, "muster"), manifestPath = join15(runtimeDir, MANIFEST), configPath = join15(dir, "hooks.json");
  const manifestExists = await exists(manifestPath), configExists = await exists(configPath);
  const manifestRaw = manifestExists ? await readJson2(manifestPath) : null;
  const previous = manifestExists ? validateHookManifest(manifestRaw, runtimeDir, manifestPath) : null;
  let config = { hooks: {} };
  if (configExists) {
    config = await readJson2(configPath);
    if (!config || typeof config !== "object" || Array.isArray(config) || config.hooks !== void 0 && (typeof config.hooks !== "object" || Array.isArray(config.hooks))) {
      throw new Error(`Codex hook configuration conflict: ${configPath} is not a valid hooks.json object. Repair it, then rerun the command.`);
    }
    config.hooks ||= {};
    for (const [event, groups] of Object.entries(config.hooks)) if (!Array.isArray(groups)) {
      throw new Error(`Codex hook configuration conflict: ${configPath} has a non-array ${event} hook group.`);
    }
  }
  if (!previous && Object.values(config.hooks).flat().some((group) => groupCommands(group).some(isMusterHookCommand))) {
    throw new Error(`Codex hook conflict: ${configPath} contains an unmanaged Muster hook. Remove it or restore its Muster manifest, then rerun the command.`);
  }
  if (previous) config = removeOwnedHookGroups(config, previous.hookGroups, configPath);
  const templatePath = join15(root, "codex", "hooks", "hooks.json");
  const template = await readJson2(templatePath);
  if (!template?.hooks || typeof template.hooks !== "object") throw new Error(`Codex hook template is missing or malformed: ${templatePath}`);
  const runtimeScript = join15(runtimeDir, "hooks", "muster-hook.mjs");
  const command = shellCommand(runtimeScript);
  const hookGroups = clone(template.hooks);
  for (const groups of Object.values(hookGroups)) for (const group of groups) for (const hook of group.hooks || []) {
    hook.command = command.command;
    hook.commandWindows = command.commandWindows;
  }
  for (const [event, groups] of Object.entries(hookGroups)) config.hooks[event] = [...config.hooks[event] || [], ...groups];
  return {
    dir,
    runtimeDir,
    manifestPath,
    manifestExists,
    configPath,
    configExists,
    config,
    staleFiles: (previous?.files || []).filter((file) => !HOOK_FILES.includes(file)),
    manifest: { format: 1, owner: "muster", files: HOOK_FILES, hookConfigCreated: previous?.hookConfigCreated ?? !configExists, hookGroups },
    sourceFiles: /* @__PURE__ */ new Map([
      ["hooks/muster-hook.mjs", join15(root, "codex", "hooks", "muster-hook.mjs")],
      ["hooks/action-guard.mjs", join15(root, "codex", "hooks", "action-guard.mjs")]
    ])
  };
}
async function snapshot(originals, changed, path) {
  if (originals.has(path)) return;
  originals.set(path, await exists(path) ? await readFile10(path, "utf8") : null);
  changed.push(path);
}
async function restoreFilesystem(originals, changed) {
  for (const destination of [...changed].reverse()) {
    if (originals.get(destination) === null) await rm3(destination, { force: true });
    else {
      await mkdir6(dirname4(destination), { recursive: true });
      await writeFile7(destination, originals.get(destination), "utf8");
    }
  }
}
function normalizedLocalRoot(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return resolve2(value.trim()).replaceAll("\\", "/");
}
function sameLocalRoot(left, right) {
  const actual = normalizedLocalRoot(left), expected = normalizedLocalRoot(right);
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  const wslDrive = /^\/mnt\/[a-z](?:\/|$)/i;
  return wslDrive.test(actual) && wslDrive.test(expected) && actual.toLowerCase() === expected.toLowerCase();
}
function trustedMusterMarketplace(item, repoRoot) {
  const source = item?.marketplaceSource;
  if (source?.sourceType === "git") return source.source === CODEX_MARKETPLACE_URL;
  return source?.sourceType === "local" && sameLocalRoot(item.root, repoRoot) && sameLocalRoot(source.source, repoRoot);
}
async function existingMusterMarketplace(execFile6, repoRoot) {
  const result = await runJson(execFile6, ["plugin", "marketplace", "list", "--json"]);
  const matches = Array.isArray(result?.marketplaces) ? result.marketplaces.filter((item) => item.name === "muster") : [];
  if (matches.some((item) => !trustedMusterMarketplace(item, repoRoot))) {
    throw new Error(`Codex marketplace conflict: "muster" is registered from an unexpected source. Run "codex plugin marketplace remove muster", then rerun muster install codex.`);
  }
  return matches[0];
}
async function registerPlugin(execFile6, dryRun, repoRoot) {
  if (dryRun) return [`codex plugin marketplace add ${CODEX_MARKETPLACE}`, `codex plugin add ${CODEX_PLUGIN}`];
  let marketplaceAdded = false, pluginAdded = false;
  try {
    const marketplace = await existingMusterMarketplace(execFile6, repoRoot);
    if (!marketplace) {
      await run(execFile6, ["plugin", "marketplace", "add", CODEX_MARKETPLACE]);
      marketplaceAdded = true;
    }
    await runJson(execFile6, ["plugin", "list", "--available", "--json"]);
    await run(execFile6, ["plugin", "add", CODEX_PLUGIN]);
    pluginAdded = true;
    return [];
  } catch (error) {
    if (pluginAdded) try {
      await run(execFile6, ["plugin", "remove", CODEX_PLUGIN]);
    } catch {
    }
    if (marketplaceAdded) try {
      await run(execFile6, ["plugin", "marketplace", "remove", "muster"]);
    } catch {
    }
    throw error;
  }
}
async function runCodexInstall({ scope = "project", dryRun = false, cwd = process.cwd(), home = homedir7(), repoRoot, execFile: execFile6 = execFileDefault2 } = {}) {
  if (!["project", "user"].includes(scope)) throw new Error("codex install scope must be project or user");
  const root = repoRoot || fileURLToPath4(new URL("../", import.meta.url));
  const pluginRoot = await exists(join15(root, ".codex-plugin", "plugin.json"));
  const source = pluginRoot ? join15(root, "agents") : (await resolveCodexRelease(root)).profilesRoot;
  const files = await profileFiles(source);
  if (!files.length) throw new Error("Codex profiles are missing; run npm run build:codex first");
  const dir = agentsDir(scope, cwd, home), manifestPath = join15(dir, MANIFEST);
  const manifest = await readJson2(manifestPath);
  const manifestExists = await exists(manifestPath);
  const managedFiles = manifestExists ? validateManagedFiles(manifest, dir, manifestPath) : [];
  const hooks = await prepareHooks({ scope, cwd, home, root });
  const managed = new Set(managedFiles.map((file) => resolve2(dir, file)));
  const staleFiles = managedFiles.filter((file) => !files.includes(file));
  for (const file of files) {
    const destination = join15(dir, file);
    if (await exists(destination) && !managed.has(resolve2(destination))) throw new Error(`Codex profile conflict: ${destination}. Move it or remove it, then rerun muster install codex.`);
  }
  const present = await codexAvailable({ execFile: execFile6 });
  if (present && !dryRun) await existingMusterMarketplace(execFile6, root);
  const planned = [
    ...files.map((file) => ({ op: "write", path: join15(dir, file) })),
    ...staleFiles.map((file) => ({ op: "remove", path: join15(dir, file) })),
    ...HOOK_FILES.map((file) => ({ op: "write", path: join15(hooks.runtimeDir, file) })),
    ...hooks.staleFiles.map((file) => ({ op: "remove", path: join15(hooks.runtimeDir, file) })),
    { op: "merge", path: hooks.configPath }
  ];
  let originals, changed;
  if (!dryRun) {
    await mkdir6(dir, { recursive: true });
    originals = /* @__PURE__ */ new Map();
    changed = [];
    try {
      for (const file of files) {
        const destination = join15(dir, file);
        await snapshot(originals, changed, destination);
        await cp(join15(source, file), destination);
      }
      for (const file of staleFiles) {
        const destination = join15(dir, file);
        await snapshot(originals, changed, destination);
        await rm3(destination, { force: true });
      }
      await snapshot(originals, changed, manifestPath);
      await writeFile7(manifestPath, JSON.stringify({ format: 1, owner: "muster", files }, null, 2) + "\n", "utf8");
      for (const [file, sourcePath] of hooks.sourceFiles) {
        const destination = join15(hooks.runtimeDir, file);
        await mkdir6(dirname4(destination), { recursive: true });
        await snapshot(originals, changed, destination);
        await cp(sourcePath, destination);
      }
      for (const file of hooks.staleFiles) {
        const destination = join15(hooks.runtimeDir, file);
        await snapshot(originals, changed, destination);
        await rm3(destination, { force: true });
      }
      await mkdir6(dirname4(hooks.configPath), { recursive: true });
      await snapshot(originals, changed, hooks.configPath);
      await writeFile7(hooks.configPath, JSON.stringify(hooks.config, null, 2) + "\n", "utf8");
      await snapshot(originals, changed, hooks.manifestPath);
      await writeFile7(hooks.manifestPath, JSON.stringify(hooks.manifest, null, 2) + "\n", "utf8");
    } catch (error) {
      await restoreFilesystem(originals, changed);
      throw error;
    }
  }
  let actions = [];
  try {
    actions = present ? await registerPlugin(execFile6, dryRun, root) : [];
  } catch (error) {
    if (!dryRun) await restoreFilesystem(originals, changed);
    throw error;
  }
  return {
    ok: true,
    target: "codex",
    scope,
    dryRun,
    profiles: files.length,
    hooks: Object.keys(hooks.manifest.hookGroups).length,
    files: planned,
    plugin: present ? { registered: !dryRun, actions } : { registered: false, skipped: "codex-not-found" },
    nextSteps: present ? [] : ["npm install -g @openai/codex", `muster install codex --scope ${scope}`]
  };
}
async function runCodexUninstall({ scope = "project", dryRun = false, cwd = process.cwd(), home = homedir7(), execFile: execFile6 = execFileDefault2 } = {}) {
  if (!["project", "user"].includes(scope)) throw new Error("codex uninstall scope must be project or user");
  const dir = agentsDir(scope, cwd, home), manifestPath = join15(dir, MANIFEST), manifest = await readJson2(manifestPath);
  const manifestExists = await exists(manifestPath);
  const managedFiles = manifestExists ? validateManagedFiles(manifest, dir, manifestPath) : [];
  const files = managedFiles.map((file) => join15(dir, file));
  const hookDir = configDir(scope, cwd, home), hookRuntimeDir = join15(hookDir, "muster"), hookManifestPath = join15(hookRuntimeDir, MANIFEST), hookConfigPath = join15(hookDir, "hooks.json");
  const hookManifestExists = await exists(hookManifestPath), hookConfigExists = await exists(hookConfigPath);
  const hookManifest = hookManifestExists ? validateHookManifest(await readJson2(hookManifestPath), hookRuntimeDir, hookManifestPath) : null;
  let hookConfig = null, removeHookConfig = false;
  if (hookManifest) {
    hookConfig = hookConfigExists ? await readJson2(hookConfigPath) : { hooks: {} };
    if (!hookConfig || typeof hookConfig !== "object" || Array.isArray(hookConfig)) throw new Error(`Codex hook configuration conflict: ${hookConfigPath} is not valid JSON.`);
    hookConfig = removeOwnedHookGroups(hookConfig, hookManifest.hookGroups, hookConfigPath);
    const otherKeys = Object.keys(hookConfig).filter((key) => key !== "hooks");
    removeHookConfig = hookManifest.hookConfigCreated && otherKeys.length === 0 && Object.keys(hookConfig.hooks || {}).length === 0;
  }
  const hookFiles = hookManifest ? hookManifest.files.map((file) => join15(hookRuntimeDir, file)) : [];
  const present = await codexAvailable({ execFile: execFile6 });
  const planned = [
    ...files.map((path) => ({ op: "remove", path })),
    ...hookFiles.map((path) => ({ op: "remove", path })),
    ...hookManifest ? [{ op: removeHookConfig ? "remove" : "merge", path: hookConfigPath }] : []
  ];
  if (!dryRun) {
    const originals = /* @__PURE__ */ new Map(), changed = [];
    try {
      for (const file of files) {
        await snapshot(originals, changed, file);
        await rm3(file, { force: true });
      }
      if (manifestExists) {
        await snapshot(originals, changed, manifestPath);
        await rm3(manifestPath, { force: true });
      }
      for (const file of hookFiles) {
        await snapshot(originals, changed, file);
        await rm3(file, { force: true });
      }
      if (hookManifestExists) {
        await snapshot(originals, changed, hookManifestPath);
        await rm3(hookManifestPath, { force: true });
      }
      if (hookManifest) {
        await snapshot(originals, changed, hookConfigPath);
        if (removeHookConfig) await rm3(hookConfigPath, { force: true });
        else await writeFile7(hookConfigPath, JSON.stringify(hookConfig, null, 2) + "\n", "utf8");
      }
    } catch (error) {
      await restoreFilesystem(originals, changed);
      throw error;
    }
    for (const empty of [join15(hookRuntimeDir, "hooks"), hookRuntimeDir]) try {
      await rmdir(empty);
    } catch {
    }
    if (present) try {
      await run(execFile6, ["plugin", "remove", CODEX_PLUGIN]);
    } catch {
    }
  }
  return {
    ok: true,
    target: "codex",
    scope,
    dryRun,
    files: planned,
    plugin: present ? { removed: !dryRun } : { removed: false, skipped: "codex-not-found" },
    nextSteps: present ? [] : ["npm install -g @openai/codex", `muster uninstall codex --scope ${scope}`]
  };
}

// src/codex-doctor.js
import { readFile as readFile11, readdir as readdir10 } from "node:fs/promises";
import { join as join16 } from "node:path";
import { fileURLToPath as fileURLToPath5 } from "node:url";
import { homedir as homedir8 } from "node:os";

// src/codex.js
var CODEX_MODEL_POLICY = Object.freeze({
  haiku: Object.freeze({ model: "gpt-5.6-luna", reasoning: "high" }),
  sonnet: Object.freeze({ model: "gpt-5.6-terra", reasoning: "xhigh" }),
  opus: Object.freeze({ model: "gpt-5.6-sol", reasoning: "high" }),
  fable: Object.freeze({ model: "gpt-5.6-sol", reasoning: "max" })
});
var CODEX_COUNTS = Object.freeze({
  agents: 27,
  nativeSkills: 11,
  builtinSkills: 51,
  pipelines: 20,
  mcpTools: 21,
  primaryModes: 8,
  aliases: 3
});

// src/codex-doctor.js
async function runCodexDoctor({ root, cwd = process.cwd(), codexHome: codexHome2, execFile: execFile6 } = {}) {
  const base = root instanceof URL ? fileURLToPath5(root) : root || process.cwd();
  const isPluginRoot = await exists(join16(base, ".codex-plugin", "plugin.json"));
  let selected = null;
  if (!isPluginRoot) {
    try {
      selected = await resolveCodexRelease(base);
    } catch {
    }
  }
  const plugin = isPluginRoot ? base : selected?.pluginRoot || join16(base, ".agents", "plugins", "releases", "missing", "plugin");
  const checks = [];
  const available = await codexAvailable({ execFile: execFile6 });
  checks.push({ name: "codex-cli", ok: available, detail: available ? "codex detected on PATH" : "codex not found \u2014 profiles can be installed, plugin registration is skipped" });
  try {
    const [manifest, pkg] = await Promise.all([
      readFile11(join16(plugin, ".codex-plugin", "plugin.json"), "utf8").then(JSON.parse),
      readFile11(join16(plugin, "package.json"), "utf8").then(JSON.parse)
    ]);
    checks.push({ name: "codex-plugin", ok: manifest.name === "muster" && manifest.version === pkg.version, detail: `muster ${manifest.version || "unknown"}` });
  } catch (error) {
    checks.push({ name: "codex-plugin", ok: false, detail: error.message });
  }
  try {
    const profileDir = isPluginRoot ? join16(plugin, "agents") : selected.profilesRoot;
    const files = (await readdir10(profileDir)).filter((name) => name.endsWith(".toml"));
    checks.push({ name: "codex-agents", ok: files.length === CODEX_COUNTS.agents, detail: `${files.length}/${CODEX_COUNTS.agents} generated profiles` });
  } catch (error) {
    checks.push({ name: "codex-agents", ok: false, detail: error.message });
  }
  const required = ["runtime/muster.mjs", "runtime/muster-mcp.mjs", ".mcp.json"];
  const missing = [];
  for (const item of required) if (!await exists(join16(plugin, item))) missing.push(item);
  checks.push({ name: "codex-runtime", ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "bundled runtime and MCP entrypoint present" });
  const hookEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"];
  const hookHomes = [.../* @__PURE__ */ new Set([join16(cwd, ".codex"), codexHome2 || process.env.CODEX_HOME || join16(homedir8(), ".codex")])];
  let hookStatus = null;
  for (const dir of hookHomes) {
    try {
      const [config, owner] = await Promise.all([
        readFile11(join16(dir, "hooks.json"), "utf8").then(JSON.parse),
        readFile11(join16(dir, "muster", ".muster-managed.json"), "utf8").then(JSON.parse)
      ]);
      const commandIsMuster = (group) => (group?.hooks || []).some((hook) => [hook.command, hook.commandWindows, hook.command_windows].some((command) => typeof command === "string" && command.replaceAll("\\", "/").includes("/muster/hooks/muster-hook.mjs")));
      const configured = hookEvents.every((event) => (config.hooks?.[event] || []).some(commandIsMuster));
      const runtime = await Promise.all(["muster-hook.mjs", "action-guard.mjs"].map((file) => exists(join16(dir, "muster", "hooks", file))));
      if (owner.owner === "muster" && configured && runtime.every(Boolean)) {
        hookStatus = dir;
        break;
      }
    } catch {
    }
  }
  checks.push({ name: "codex-hooks", ok: Boolean(hookStatus), detail: hookStatus ? `managed lifecycle hooks configured at ${hookStatus}; non-managed hooks require one-time trust review in /hooks` : "managed Codex lifecycle hooks are not installed; run muster install codex for the intended project or user scope" });
  checks.push({ name: "codex-policy-limitations", ok: true, detail: "Hooks provide lifecycle context, diagnostics, and supported policy warnings; todo and spawn enforcement remain advisory, and write-capable waves require isolated worktrees" });
  if (available) {
    const inventory = await readCodexInventory({ cwd, codexHome: codexHome2, execFile: execFile6 });
    const installed = inventory.plugins.includes("muster");
    checks.push({ name: "codex-plugin-installed", ok: installed, detail: installed ? "muster plugin is enabled in live Codex state" : "muster plugin is not installed; run muster install codex" });
    checks.push({ name: "codex-inventory", ok: true, detail: `${inventory.plugins.length} plugins, ${inventory.skills.length} skills, ${inventory.mcpServers.length} MCP servers, ${inventory.agents.length} agents from live Codex state` });
  }
  return { ok: checks.every((check) => check.ok), target: "codex", checks };
}

// src/codex-catalog.js
var SUPERPOWERS_NAMES = Object.freeze({
  "sp-brainstorm": "brainstorming",
  "sp-plan": "writing-plans",
  "sp-tdd": "test-driven-development",
  "sp-review": "requesting-code-review",
  "sp-review-recv": "receiving-code-review",
  "sp-debug": "systematic-debugging",
  "sp-verify": "verification-before-completion",
  "sp-subagents": "subagent-driven-development",
  "sp-parallel": "dispatching-parallel-agents"
});
function codexFallbackSkillId(id) {
  return id.startsWith("gsd-") ? `muster-${id}` : id;
}
function nativeSkillId(id) {
  if (SUPERPOWERS_NAMES[id]) return SUPERPOWERS_NAMES[id];
  if (id.startsWith("wsh-")) return id.slice(4);
  if (id.startsWith("gsd-")) return id;
  return null;
}
function adaptCatalogForCodex(catalog, installed) {
  const liveSkills = new Set(installed?.skills || []);
  const upstream = [];
  const fallback = [];
  for (const entry of catalog) {
    if (entry.kind !== "builtin") {
      fallback.push(entry.kind === "external" && entry.detect?.kind === "plugin" ? { ...entry, detect: { ...entry.detect, codexStrictKind: true } } : entry);
      continue;
    }
    const nativeId = nativeSkillId(entry.id);
    if (nativeId && liveSkills.has(nativeId)) {
      upstream.push({
        id: nativeId,
        kind: "external",
        roles: entry.roles,
        rank: entry.id.startsWith("sp-") ? 80 : entry.id.startsWith("gsd-") ? 75 : 70,
        detect: { kind: "skill", match: nativeId },
        invoke: `invoke the enabled Codex-native $${nativeId} skill`
      });
    }
    fallback.push(entry.id.startsWith("gsd-") ? { ...entry, id: codexFallbackSkillId(entry.id) } : entry);
  }
  return [...upstream, ...fallback];
}

// src/interview.js
var CRITERIA_QUANTIFIED = /\bby \d+\b|\b\d+%|\b(?:at least|at most|above|below|under|over|within)\s+\d+\b|\b\d+\s+consecutive\b/i;
var NUMBER_WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
var CRITERIA_QUANTIFIED_WORDS = new RegExp(
  `\\bby\\s+${NUMBER_WORD}\\b|\\b(?:at least|at most|above|below|under|over|within)\\s+${NUMBER_WORD}\\b|\\b${NUMBER_WORD}\\s+consecutive\\b|\\bzero\\s+(?:failures?|errors?|defects?|regressions?|dropped|lost)\\b`,
  "i"
);
var CRITERIA_KEYWORD = /\b(metric|measure|success|criteria|kpi|target|goal|increase|decrease|reduce|improve|conversion|rate|latency|throughput)\b/i;
var MEASURABLE_NEARBY = /\b\d|\b(?:at least|at most|above|below|under|over|within)\b/i;
var MEASURABLE_WORD_NEARBY = new RegExp(`\\b${NUMBER_WORD}\\b|\\b(?:at least|at most|above|below|under|over|within)\\b`, "i");
var VAGUE_VERB = /^(make|do|build|fix|improve|help|handle|update|change)\b/i;
var SPECIFIC = /["'`]|\d|\b[a-z]+[A-Z]|\s[A-Z]/;
function assessOutcome(text, { codex = false } = {}) {
  if (typeof text !== "string" || !text.trim()) return { clear: false, signals: ["empty"] };
  const trimmed = text.trim();
  const meaningful = trimmed.split(/\s+/).filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const tooShort = meaningful.length < 6;
  const hasQuantified = CRITERIA_QUANTIFIED.test(trimmed) || codex && CRITERIA_QUANTIFIED_WORDS.test(trimmed);
  const hasKeyword = CRITERIA_KEYWORD.test(trimmed);
  const hasMeasurable = MEASURABLE_NEARBY.test(trimmed) || codex && MEASURABLE_WORD_NEARBY.test(trimmed);
  const noCriteria = !(hasQuantified || hasKeyword && hasMeasurable);
  const signals = [];
  if (tooShort) signals.push("too-short");
  if (noCriteria) signals.push("no-success-criteria");
  if (tooShort && noCriteria && VAGUE_VERB.test(trimmed) && !SPECIFIC.test(trimmed)) {
    signals.push("vague-only");
  }
  return { clear: signals.length === 0, signals };
}

// src/cli-args.js
function parseDomainArgs(rest) {
  const di = rest.indexOf("--domain");
  const override = di >= 0 ? rest[di + 1] : void 0;
  const skip = new Set(di >= 0 ? [di, di + 1] : []);
  const outcome = rest.find((_, i) => !skip.has(i)) || "";
  return { override, outcome };
}
function requireArg(rest, idx, usage, fail2) {
  if (!rest[idx]) fail2(usage);
  return rest[idx];
}
function flagValue(rest, name) {
  const i = rest.indexOf(name);
  const v = i >= 0 ? rest[i + 1] : void 0;
  return v !== void 0 && v.startsWith("--") ? void 0 : v;
}
function formatError(e, env = process.env) {
  return env.DEBUG ? e.stack || e.message : e.message;
}

// src/prioritize.js
function requirePositiveFinite(value, factor, fn, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`${fn}: "${name}" ${factor} must be a positive finite number, got ${value}`);
}
function requireNonNegativeFinite(value, factor, fn, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`${fn}: "${name}" ${factor} must be a non-negative finite number, got ${value}`);
}
function scoreAndRank(items, fn, rawScore) {
  if (!Array.isArray(items))
    throw new Error(`${fn}: items must be an array, got ${typeof items}`);
  const scored = items.map((item, i) => {
    const name = item?.name;
    if (typeof name !== "string" || !name.trim())
      throw new Error(`${fn}: item at index ${i} must have a non-empty string "name"`);
    const raw = rawScore(item, name);
    const score = Math.round(raw * 100) / 100;
    return { ...item, score };
  });
  scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return scored.map((item, i) => ({ ...item, rank: i + 1 }));
}
function prioritizeRICE(items) {
  return scoreAndRank(items, "prioritizeRICE", (item, name) => {
    requirePositiveFinite(item.reach, "reach", "prioritizeRICE", name);
    requirePositiveFinite(item.impact, "impact", "prioritizeRICE", name);
    requirePositiveFinite(item.confidence, "confidence", "prioritizeRICE", name);
    if (typeof item.effort !== "number" || !Number.isFinite(item.effort) || item.effort <= 0)
      throw new Error(`prioritizeRICE: "${name}" effort must be > 0, got ${item.effort}`);
    return item.reach * item.impact * item.confidence / item.effort;
  });
}
function prioritizeICE(items) {
  return scoreAndRank(items, "prioritizeICE", (item, name) => {
    requirePositiveFinite(item.impact, "impact", "prioritizeICE", name);
    requirePositiveFinite(item.confidence, "confidence", "prioritizeICE", name);
    requirePositiveFinite(item.ease, "ease", "prioritizeICE", name);
    return item.impact * item.confidence * item.ease;
  });
}
function prioritizeWSJF(items) {
  return scoreAndRank(items, "prioritizeWSJF", (item, name) => {
    requirePositiveFinite(item.costOfDelay, "costOfDelay", "prioritizeWSJF", name);
    if (typeof item.jobSize !== "number" || !Number.isFinite(item.jobSize) || item.jobSize <= 0)
      throw new Error(`prioritizeWSJF: "${name}" jobSize must be > 0, got ${item.jobSize}`);
    return item.costOfDelay / item.jobSize;
  });
}
function prioritizeWeighted(items) {
  return scoreAndRank(items, "prioritizeWeighted", (item, name) => {
    const criteria = item?.criteria;
    if (!Array.isArray(criteria) || criteria.length === 0)
      throw new Error(`prioritizeWeighted: "${name}" must have a non-empty "criteria" array`);
    return criteria.reduce((sum, c, j) => {
      requirePositiveFinite(c?.weight, `criteria[${j}].weight`, "prioritizeWeighted", name);
      requireNonNegativeFinite(c?.score, `criteria[${j}].score`, "prioritizeWeighted", name);
      return sum + c.weight * c.score;
    }, 0);
  });
}
var MODELS = {
  rice: prioritizeRICE,
  ice: prioritizeICE,
  wsjf: prioritizeWSJF,
  weighted: prioritizeWeighted
};
function prioritize(items, model = "rice") {
  const scorer = MODELS[model];
  if (!scorer)
    throw new Error(`unsupported model: ${model} (supported: ${Object.keys(MODELS).join(", ")})`);
  return scorer(items);
}

// src/issue.js
import { execFile as execFile5 } from "node:child_process";
import { promisify as promisify7 } from "node:util";
var BARE = /^[1-9]\d*$/;
var HASH = /^#[1-9]\d*$/;
var URL2 = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/([1-9]\d*)\/?(\?.*)?$/;
function parseIssueRef(arg) {
  if (typeof arg !== "string") return { kind: "text" };
  const s = arg.trim();
  if (BARE.test(s)) return { kind: "issue", number: Number(s) };
  if (HASH.test(s)) return { kind: "issue", number: Number(s.slice(1)) };
  const m = URL2.exec(s);
  if (m) return { kind: "issue", number: Number(m[1]) };
  return { kind: "text" };
}
async function resolveIssue(ref, { exec } = {}) {
  const run2 = exec || promisify7(execFile5);
  const parsed = parseIssueRef(ref);
  if (parsed.kind !== "issue") {
    throw new Error("not a GitHub issue reference: " + ref);
  }
  const { number } = parsed;
  try {
    const { stdout } = await run2("gh", [
      "issue",
      "view",
      String(number),
      "--json",
      "number,title,body"
    ]);
    const { number: n, title, body } = JSON.parse(stdout);
    return { number: n, title, body, outcome: `${title}

${body}` };
  } catch (e) {
    throw new Error(`failed to resolve issue #${number} via gh: ${e.message}`);
  }
}

// src/steer.js
var RULES = [
  {
    action: "stop",
    patterns: [/\bstop\b/i, /\bhalt\b/i, /\babort\b/i, /\bcancel\b/i, /\bpause\b/i, /\bhold\b/i]
  },
  {
    action: "retarget",
    patterns: [
      /\binstead\b/i,
      /\bretarget\b/i,
      /\bredirect\b/i,
      /\bswitch to\b/i,
      /\bchange scope\b/i,
      /\balso do\b/i,
      /\brescope\b/i
    ]
  },
  {
    action: "approve",
    patterns: [
      /\bapprove[d]?\b/i,
      /\bcontinue\b/i,
      /\bproceed\b/i,
      /\blgtm\b/i,
      /\bgo ahead\b/i,
      /\bship it\b/i,
      /\byes\b/i,
      /\bok\b/i,
      /\bokay\b/i
    ]
  },
  {
    action: "status",
    patterns: [
      /\bstatus\b/i,
      /\bprogress\b/i,
      /\bupdate\b/i,
      /\bchecklist\b/i,
      /\bwhere are we\b/i,
      /\bhow'?s it going\b/i,
      /\bhow is it going\b/i
    ]
  }
];
function classifySteer(text) {
  if (typeof text !== "string") return { action: "unknown" };
  const trimmed = text.trim();
  if (!trimmed) return { action: "unknown" };
  for (const { action, patterns } of RULES) {
    if (patterns.some((re) => re.test(trimmed))) return { action };
  }
  return { action: "unknown" };
}

// src/prompt-lint.js
var BP = "https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices";
var GUARD = "https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails";
var LINTLANG = "https://github.com/hermes-labs-ai/lintlang";
var surface = (text, ctx) => `${ctx.system ? ctx.system + "\n" : ""}${text || ""}`;
var has = (re) => (text, ctx) => re.test(surface(text, ctx));
var firstLines = (text, n = 4) => (text || "").split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, n);
function stripCode(s) {
  let fence = null;
  const out2 = String(s).split("\n").map((line) => {
    const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence) fence = null;
      return " ";
    }
    if (m) {
      fence = m[1][0];
      return " ";
    }
    if (/^(?: {4}|\t)\S/.test(line)) return " ";
    return line;
  }).join("\n");
  return out2.replace(/<pre\b[\s\S]*?<\/pre>/gi, " ").replace(/<code\b[\s\S]*?<\/code>/gi, " ").replace(/`[^`\n]*`/g, " ");
}
var INTERP_RE = /\{\{\s*[\w.]+\s*\}\}|\$\{\s*[\w.]+\s*\}|#\{\s*[\w.]+\s*\}|<%=?\s*[\w.]+\s*%>|%\([\w.]+\)[sd]/;
var hasInterpolation = (text, ctx) => INTERP_RE.test(stripCode(text || "")) || Array.isArray(ctx.interpolatedVars) && ctx.interpolatedVars.length > 0;
var hasXmlBlock = (text) => {
  if (!text) return false;
  const opens = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(/<([a-zA-Z][\w-]*)[\s>]/g)) opens.add(m[1]);
  if (opens.size === 0) return false;
  for (const m of text.matchAll(/<\/([a-zA-Z][\w-]*)>/g)) if (opens.has(m[1])) return true;
  return false;
};
var ACTION_VERB = /^(write|generate|classify|summari[sz]e|extract|identify|analy[sz]e|create|list|translate|rewrite|explain|compare|evaluate|produce|return|find|select|determine|draft|review)\b/i;
var NEGATIVE_SRC = "\\b(do not|don'?t|never|avoid|no\\s+(?:log|cach|retr|truncat|format|wrap|generat|output|process|nest|render)\\w*ing)\\b";
var NEGATIVE_RE = new RegExp(NEGATIVE_SRC, "gi");
var RULES2 = [
  {
    id: "ANTH-ROLE-001",
    severity: "error",
    systemSeverity: "warn",
    dimension: "structure",
    title: "Assign Claude a role (system prompt / persona)",
    source: BP,
    applies: () => true,
    pass: (t, c) => {
      const s = surface(t, c);
      if (/\byou are\b|\byour role is\b|\bact as\b/i.test(s)) return true;
      return firstLines(s).some((l) => /^you\s+[a-z]+/i.test(l) && !/^you\s+(can|could|may|might|should|would|will|must|need|have|receive|get|got|find|obtain|hold|contain|see)\b/i.test(l));
    },
    fix: "Open with a role, e.g. 'You are a senior X who ...' (system prompt preferred)."
  },
  {
    // NOTE: XML-block check intentionally mirrors GUARD-SEP-003 (guardrails). Each fires
    // on an independent axis: structural best-practice vs. prompt-injection defence.
    id: "ANTH-XML-001",
    severity: "warn",
    dimension: "structure",
    title: "Wrap interpolated/long content in descriptive XML tags",
    source: BP,
    applies: (t, c) => hasInterpolation(t, c),
    pass: (t) => hasXmlBlock(t),
    fix: "Wrap injected content in descriptive tags, e.g. <document>{{x}}</document>."
  },
  {
    id: "ANTH-FMT-001",
    severity: "warn",
    systemSeverity: "info",
    dimension: "structure",
    title: "State the output format explicitly",
    source: BP,
    applies: () => true,
    // Require a format *instruction*, not a bare keyword — "don't use markdown" is not
    // an output-format spec. Anchor on directive phrasing or an output-semantic tag
    // (NOT any XML block: <document>{{x}}</document> wraps *input*, not output format).
    pass: has(/format (your|the) (response|answer|output)|respond with|reply with|(?:return|output|produce|reply|emit|respond|generate)[^.\n]{0,40}?\b(json|xml|markdown|yaml|csv|list|object|array|table)\b|as (a|an) (json|xml|markdown|yaml|csv)|<(json|output|format|response|result|answer)\b|one [\w-]+ per line|one per line|per (finding|item|line|row|entry)\b|as (?:a |an )?(?:bullet(?:ed)?|numbered|markdown)\s*(?:list|table)|prefix(?:ed)? (?:each |every )?\w+ with/i),
    fix: "Name the exact output format (JSON shape, prose, markdown, or a clear per-line/list spec)."
  },
  {
    id: "ANTH-SHOT-001",
    severity: "warn",
    dimension: "examples",
    taskOnly: true,
    title: "Provide examples (multishot) for non-trivial tasks",
    source: BP,
    applies: (t) => (t || "").length > 200,
    pass: has(/<example[s]?\b|\bexample\s*\d*\s*:|for example,/i),
    fix: "Add 2-5 relevant, diverse examples wrapped in <example> tags."
  },
  {
    id: "ANTH-POS-001",
    severity: "warn",
    dimension: "clarity",
    title: "Prefer positive instructions over negative ones",
    source: BP,
    applies: () => true,
    pass: (t, c) => {
      NEGATIVE_RE.lastIndex = 0;
      const s = stripCode(surface(t, c));
      const neg = (s.match(NEGATIVE_RE) || []).length;
      return neg <= (c.genre === "system" ? 5 : 2);
    },
    fix: "Tell Claude what TO do instead of stacking 'do not / never' clauses."
  },
  {
    id: "ANTH-CLEAR-001",
    severity: "info",
    dimension: "clarity",
    taskOnly: true,
    title: "Lead with a clear, direct action-verb instruction",
    source: BP,
    applies: () => true,
    // Any of the opening lines leading with an action verb counts — a role line on
    // line 1 followed by "Classify the ..." on line 2 is still clear and direct.
    pass: (t) => firstLines(t).some((l) => ACTION_VERB.test(l)),
    fix: "Start the task line with an action verb (Write, Classify, Extract, ...)."
  },
  {
    id: "LINT-TOOL-001",
    severity: "warn",
    dimension: "agentic",
    title: "Frame tool use imperatively, not suggestively",
    source: LINTLANG,
    applies: (t, c) => !!c.hasTools || !!c.isAgent,
    pass: (t, c) => {
      const s = surface(t, c);
      return /\buse the\b|\bcall the\b|\binvoke\b|\bimplement\b/i.test(s) && !/\byou (can|could|may|might)\b/i.test(s);
    },
    fix: "Say 'Use the X tool to ...' / 'Implement ...', not 'you can use ...'."
  },
  {
    id: "LINT-STOP-002",
    severity: "warn",
    dimension: "agentic",
    title: "Define stop / termination conditions for agents",
    source: LINTLANG,
    applies: (t, c) => !!c.isAgent,
    pass: has(/\bstop when\b|when (you are |you're )?(done|finished|complete)|\buntil\b|\bterminat|\bfinish(ed)? (when|once)/i),
    fix: "State when to stop, e.g. 'Stop once the tests pass or after N attempts.'"
  },
  {
    // lintlang H3 (schema-intent mismatch). Only fires when the caller passes the actual tool
    // schemas via ctx.tools = [{ name, inputSchema:{ required:[...] } }] — a bare `--tools` flag
    // (hasTools) does NOT trigger it, because without the schema there is nothing to check against.
    id: "LINT-SCHEMA-003",
    severity: "warn",
    dimension: "agentic",
    title: "Reference every provided tool and its required fields (schema\u2194intent alignment)",
    source: LINTLANG,
    applies: (t, c) => Array.isArray(c.tools) && c.tools.length > 0,
    pass: (t, c) => {
      const s = surface(t, c).toLowerCase();
      const refs = (w) => new RegExp(`\\b${escapeRe(String(w).toLowerCase())}\\b`).test(s);
      return c.tools.every((tool) => {
        const name = tool && tool.name || "";
        if (!name || !refs(name)) return false;
        const req = tool.inputSchema && tool.inputSchema.required || [];
        return req.every(refs);
      });
    },
    fix: "Name every callable tool and reference each of its required arguments so the prompt's intent matches the tool schema."
  },
  {
    id: "GUARD-IDK-001",
    severity: "info",
    dimension: "guardrails",
    title: "Allow 'I don't know' to reduce hallucination",
    source: `${GUARD}/reduce-hallucinations`,
    applies: has(/\b(answer|question|fact|factual)\b/i),
    pass: has(/i don'?t know|if (you are |you're )?unsure|if you (do not|don'?t) know|say so/i),
    fix: "Permit Claude to answer 'I don't know' when the context lacks the answer."
  },
  {
    id: "GUARD-CITE-002",
    severity: "info",
    dimension: "guardrails",
    title: "Require citations/quotes when given source documents",
    source: `${GUARD}/reduce-hallucinations`,
    applies: (t, c) => !!c.hasDocuments || /<document|<context|<source/i.test(t || ""),
    // Require a citation *directive*, not a bare mention of the word "source"
    // ("source code" / "data source" must not satisfy this rule).
    pass: has(/\bcite\b|\bquote\b|with citations?|cite (your |the )?sources?|reference the (source|document|passage)/i),
    fix: "Require a supporting quote/citation for each factual claim."
  },
  {
    // NOTE: XML-block check intentionally mirrors ANTH-XML-001 (structure). Each fires
    // on an independent axis: prompt-injection defence vs. structural best-practice.
    id: "GUARD-SEP-003",
    severity: "warn",
    dimension: "guardrails",
    title: "Separate untrusted/interpolated input from instructions",
    source: `${GUARD}/reduce-prompt-leak`,
    applies: (t, c) => hasInterpolation(t, c),
    pass: (t) => hasXmlBlock(t),
    fix: "Place injected/user content inside its own XML block, away from instructions."
  }
];
var DIMENSIONS = ["structure", "examples", "clarity", "agentic", "guardrails"];
var DEFAULT_GATE = { floor: 1, pass_total: 10 };
function disabledRules(text) {
  const ids = /* @__PURE__ */ new Set();
  const re = /prompt-lint-disable[:\s]+([A-Z][A-Z0-9-]*(?:\s*,\s*[A-Z][A-Z0-9-]*)*)/gi;
  let m;
  while ((m = re.exec(text)) !== null)
    for (const id of m[1].split(/\s*,\s*/)) ids.add(id.toUpperCase());
  return ids;
}
function lintPrompt(text, ctx = {}, gate = DEFAULT_GATE) {
  const findings = [];
  const perDim = Object.fromEntries(DIMENSIONS.map((d) => [d, { applicable: 0, passed: 0 }]));
  const systemGenre = ctx.genre === "system";
  const disabled = disabledRules(surface(text, ctx));
  const suppressed = [];
  for (const rule of RULES2) {
    if (rule.taskOnly && systemGenre) continue;
    if (disabled.has(rule.id)) {
      suppressed.push(rule.id);
      continue;
    }
    if (!rule.applies(text, ctx)) continue;
    const severity = systemGenre && rule.systemSeverity || rule.severity;
    const ok = rule.pass(text, ctx);
    const dim = perDim[rule.dimension];
    dim.applicable += 1;
    if (ok) dim.passed += 1;
    if (!ok) findings.push({
      id: rule.id,
      severity,
      dimension: rule.dimension,
      title: rule.title,
      source: rule.source,
      fix: rule.fix
    });
  }
  const rubric = {};
  for (const d of DIMENSIONS) {
    const { applicable, passed } = perDim[d];
    rubric[d] = applicable === 0 ? 3 : Math.round(passed / applicable * 3);
  }
  const { total, weakest, passing } = scoreArtifact(rubric, gate);
  const rank = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { rubric, findings, total, weakest, passing, gate, suppressed };
}
var ROLE_BLEED = /^\s*(system|assistant|user)\s*:/im;
function lintChat(messages) {
  const findings = [];
  const add = (id, title, detail) => findings.push({ id, severity: "warn", dimension: "structure", title, detail, source: LINTLANG });
  if (!Array.isArray(messages) || messages.length === 0) {
    add("LINT-ROLE-010", "Chat must be a non-empty array of {role, content}", "no messages to lint");
    return { findings, ok: false };
  }
  messages.forEach((m, i) => {
    const role = m && m.role;
    if (role === "system" && i !== 0)
      add("LINT-ROLE-011", "System message must be first", `system role found at index ${i}`);
    if (i > 0) {
      const prev = messages[i - 1] && messages[i - 1].role;
      if (role && role !== "system" && role === prev)
        add("LINT-ROLE-012", "Roles should alternate (no two consecutive same-role turns)", `${role} follows ${prev} at index ${i}`);
    }
    const content = m && m.content;
    const contentText = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b && typeof b.text === "string" ? b.text : "").join("\n") : "";
    if (contentText && ROLE_BLEED.test(contentText))
      add("LINT-ROLE-013", "Role bleed: content embeds a role marker that can confuse turn parsing", `index ${i} content opens with a 'role:' marker`);
  });
  return { findings, ok: findings.length === 0 };
}
var STATE_TOKEN = /\.muster\/[\w./-]+|\b[\w-]+\.(?:json|txt|md|log)\b|\b[\w-]*[._-](?:state|scratch|memory|ledger)[\w-]*\b|\b(?:state|scratch|memory|ledger)[._-][\w-]+\b/gi;
function lintWorkflow(prompts) {
  const findings = [];
  if (!Array.isArray(prompts) || prompts.length < 2) return { findings, ok: true };
  const items = prompts.map((p, i) => ({ id: p && p.id || `prompt[${i}]`, text: typeof p === "string" ? p : p && p.text || "" }));
  const seen = /* @__PURE__ */ new Map();
  for (const it of items) {
    for (const raw of it.text.match(STATE_TOKEN) || []) {
      const tok = raw.toLowerCase();
      if (!seen.has(tok)) seen.set(tok, /* @__PURE__ */ new Set());
      seen.get(tok).add(it.id);
    }
  }
  for (const [tok, ids] of seen) {
    if (ids.size >= 2)
      findings.push({
        id: "LINT-CTX-020",
        severity: "warn",
        dimension: "guardrails",
        title: "Shared mutable-state artifact referenced across sibling tasks (context-boundary erosion)",
        detail: `'${tok}' referenced by ${[...ids].join(", ")}`,
        source: LINTLANG,
        fix: "Give each task its own scoped state, or declare the shared artifact read-only / owned by one task."
      });
  }
  return { findings, ok: findings.length === 0 };
}

// src/humanizer-score.js
var DETECTORS = [
  { category: "em/en-dash-or-curly-quote", weight: 7, cap: 28, re: /[—–“”‘’]/g },
  { category: "banned-opener", weight: 6, cap: 24, re: /(?:^|\n)\s*(?:Certainly|Moreover|Additionally|Furthermore|Indeed|Notably|Importantly|Ultimately|Overall)\b/gi },
  { category: "signposting", weight: 5, cap: 25, re: /\b(?:it'?s important to note|in today'?s world|at the end of the day|when it comes to|needless to say|let'?s dive in|in conclusion|that being said)\b/gi },
  { category: "tier1-vocab", weight: 4, cap: 28, re: /\b(?:delve|leverage|tapestry|realm|testament|foster|robust|seamless|elevate|embark|landscape|paradigm|harness|pivotal|multifaceted|underscore|showcase|utilize|facilitate|holistic|synergy|game-changer|cutting-edge|unlock)\b/gi },
  { category: "negative-parallelism", weight: 6, cap: 18, re: /\bnot just\b[^.\n]{1,60}?\b(?:it'?s|but)\b|\bit'?s not (?:about|just)\b[^.\n]{1,60}?\bit'?s\b/gi },
  { category: "copula-avoidance", weight: 3, cap: 12, re: /\b(?:serves as|boasts|stands as|functions as|plays a (?:crucial|key|vital|pivotal|significant) role)\b/gi },
  { category: "sycophancy", weight: 6, cap: 18, re: /\b(?:great question|i hope this helps|as an ai|happy to help|i'?m just an ai)\b/gi },
  // Emoji & pictographs (1F300–1FAFF) + regional-indicator flag letters (1F1E6–1F1FF). The old
  // 2600–27BF block was dropped: it flagged ordinary typographic dingbats (✓ ★ ☎ ✏ ♻) as AI tells.
  // ZWJ-sequence emoji still count — each component sits in 1F300–1FAFF.
  { category: "emoji", weight: 4, cap: 12, re: /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}]/gu }
];
function scoreHumanness(text, { threshold = 85 } = {}) {
  const s = String(text || "");
  const findings = [];
  let penalty = 0;
  for (const d of DETECTORS) {
    const matches = s.match(d.re) || [];
    if (matches.length === 0) continue;
    const raw = matches.length * d.weight;
    const applied = Math.min(d.cap, raw);
    penalty += applied;
    findings.push({
      category: d.category,
      count: matches.length,
      penalty: applied,
      capped: raw > d.cap,
      examples: [...new Set(matches.map((m) => m.trim()).filter(Boolean))].slice(0, 2)
    });
  }
  findings.sort((a, b) => b.penalty - a.penalty);
  const score = Math.max(0, 100 - penalty);
  return { score, passing: score >= threshold, threshold, penalty, findings };
}

// src/citation-guard.js
var CITE_SOURCE = "\\[src:\\s*([A-Za-z0-9_.-]+)\\s*\\]";
var CITE_SOURCE_LOOSE = "\\[src:\\s*([^\\]]*)\\]";
var ANCHOR_RE = /^[A-Za-z0-9_.-]+$/;
var SOURCE_ENTRY_RE = /^[-*]\s+([A-Za-z0-9_.-]+)\s*:\s*(.+)$/;
function headingMatch(line) {
  const m = /^(#{1,6})\s*(.*)$/.exec(line);
  return m ? { level: m[1].length, text: m[2].trim() } : null;
}
function findSourcesMask(lines, fence) {
  const sourceMask = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (fence[i]) continue;
    const h = headingMatch(lines[i]);
    if (!h || !/^sources$/i.test(h.text)) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (fence[j]) continue;
      const h2 = headingMatch(lines[j]);
      if (h2 && h2.level <= h.level) {
        end = j;
        break;
      }
    }
    for (let k = i; k < end; k++) sourceMask[k] = true;
    break;
  }
  return sourceMask;
}
function parseSources(lines, sourceMask) {
  const map = /* @__PURE__ */ new Map();
  lines.forEach((line, i) => {
    if (!sourceMask[i]) return;
    const m = SOURCE_ENTRY_RE.exec(line.trim());
    if (!m) return;
    const anchor = m[1];
    if (!map.has(anchor)) map.set(anchor, { target: m[2].trim(), lines: [] });
    map.get(anchor).lines.push(i + 1);
  });
  return map;
}
function maskInlineCode(line) {
  return line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}
function fenceMask(lines) {
  const mask = [];
  let inFence = false;
  for (const line of lines) {
    const isFence = /^\s*```/.test(line);
    mask.push(inFence || isFence);
    if (isFence) inFence = !inFence;
  }
  return mask;
}
var LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
function paragraphs(lines, mask) {
  const out2 = [];
  let cur = [], start = null;
  const flush = () => {
    if (!cur.length) return;
    if (LIST_ITEM_RE.test(cur[0])) {
      let itemLines = [cur[0]], itemStart = start;
      for (let i = 1; i < cur.length; i++) {
        if (LIST_ITEM_RE.test(cur[i])) {
          out2.push({ text: itemLines.join("\n"), line: itemStart });
          itemLines = [cur[i]];
          itemStart = start + i;
        } else {
          itemLines.push(cur[i]);
        }
      }
      out2.push({ text: itemLines.join("\n"), line: itemStart });
    } else {
      out2.push({ text: cur.join("\n"), line: start });
    }
    cur = [];
    start = null;
  };
  lines.forEach((line, i) => {
    if (mask[i] || !line.trim() || /^\s*#{1,6}\s/.test(line)) {
      flush();
      return;
    }
    if (start === null) start = i + 1;
    cur.push(maskInlineCode(line));
  });
  flush();
  return out2;
}
function checkCitations(text) {
  const src = String(text ?? "");
  const lines = src.split("\n");
  const fence = fenceMask(lines);
  const sourceMask = findSourcesMask(lines, fence);
  const sources = parseSources(lines, sourceMask);
  const mask = lines.map((_, i) => fence[i] || sourceMask[i]);
  const danglingAnchors = [];
  const malformedCitations = [];
  lines.forEach((line, i) => {
    if (mask[i]) return;
    const re = new RegExp(CITE_SOURCE_LOOSE, "g");
    let m;
    while (m = re.exec(maskInlineCode(line))) {
      const raw = m[1].trim();
      if (!ANCHOR_RE.test(raw)) {
        malformedCitations.push({ line: i + 1, raw });
      } else if (!sources.has(raw)) {
        danglingAnchors.push({ anchor: raw, line: i + 1 });
      }
    }
  });
  const paras = paragraphs(lines, mask);
  const citeTest = new RegExp(CITE_SOURCE);
  const uncited = paras.filter((p) => !citeTest.test(p.text)).map((p) => p.line);
  const warnings = [];
  for (const [anchor, entry] of sources) {
    if (entry.lines.length > 1) warnings.push({ type: "duplicate-source", anchor, lines: entry.lines });
  }
  return {
    ok: danglingAnchors.length === 0 && malformedCitations.length === 0,
    claims: paras.length,
    cited: paras.length - uncited.length,
    uncited,
    danglingAnchors,
    malformedCitations,
    warnings
  };
}

// src/prompt-eval.js
function validateJson(s) {
  try {
    JSON.parse(s);
    return 10;
  } catch {
    return 0;
  }
}
function validateRegex(s) {
  if (typeof s !== "string" || s.length > 4096) return 0;
  try {
    new RegExp(s);
    return 10;
  } catch {
    return 0;
  }
}
var PY_SIGNAL = /\b(def|class|import|from|return|for|while|if|elif|else|with|lambda|print|yield|async|await)\b|:\s*\n\s+\S/;
function validatePython(s) {
  const t = String(s).trim();
  if (!t) return 0;
  const balanced = (open2, close) => t.split(open2).length - 1 === t.split(close).length - 1;
  const delimitersOk = balanced("(", ")") && balanced("[", "]") && balanced("{", "}");
  return delimitersOk && PY_SIGNAL.test(t) ? 10 : 0;
}
function stripFence(s) {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(String(s));
  return (m ? m[1] : String(s)).trim();
}
function isToolCallShape(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const name = obj.name ?? obj.tool ?? obj.function ?? obj.tool_name;
  const args = obj.arguments ?? obj.input ?? obj.parameters ?? obj.args;
  return typeof name === "string" && name.length > 0 && args !== null && typeof args === "object" && !Array.isArray(args);
}
function validateToolCall(s) {
  let obj;
  try {
    obj = JSON.parse(stripFence(s));
  } catch {
    return 0;
  }
  return isToolCallShape(obj) ? 10 : 0;
}
function validateTrajectory(s) {
  let arr;
  try {
    arr = JSON.parse(stripFence(s));
  } catch {
    return 0;
  }
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  return arr.every(isToolCallShape) ? 10 : 0;
}
var CODE_GRADERS = { json: validateJson, regex: validateRegex, python: validatePython, "tool-call": validateToolCall, trajectory: validateTrajectory };
function codeGrade(output, format) {
  if (!format) return null;
  const grader = CODE_GRADERS[String(format).toLowerCase()];
  return grader ? grader(String(output)) : null;
}
function parseGraderResponse(text) {
  let obj = {};
  try {
    obj = JSON.parse(stripFence(text));
  } catch {
    const m = /"?score"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i.exec(text);
    obj = { score: m ? Number(m[1]) : 0, reasoning: "unparseable grader response" };
  }
  const score = Math.max(0, Math.min(10, Number(obj.score) || 0));
  return { score, reasoning: obj.reasoning || "", strengths: obj.strengths || "", weaknesses: obj.weaknesses || "" };
}
function combineScores(code, model) {
  if (code != null && model != null) return (code + model) / 2;
  return code ?? model ?? 0;
}
function summarize(results, passThreshold) {
  const passing = results.filter((r) => r.passing).length;
  return {
    results,
    total: results.length,
    accuracy: results.length > 0 ? passing / results.length : 0,
    averageScore: results.length > 0 ? results.reduce((s, r) => s + r.score, 0) / results.length : 0,
    passThreshold
  };
}
function gradeCollected({ dataset, passThreshold = 7 }) {
  if (!Array.isArray(dataset) || dataset.length === 0)
    throw new Error("gradeCollected: dataset must be a non-empty array");
  const results = dataset.map((entry) => {
    const { output, format, graderResponse } = entry;
    const code = codeGrade(output, format);
    const model = graderResponse != null ? parseGraderResponse(String(graderResponse)).score : null;
    const score = combineScores(code, model);
    return { output, format, graderResponse, codeScore: code, modelScore: model, score, passing: score >= passThreshold };
  });
  return summarize(results, passThreshold);
}

// src/prompt-optimize.js
var VAR_RE = /\{\{\s*([\w.]+)\s*\}\}|\$\{\s*([\w.]+)\s*\}|#\{\s*([\w.]+)\s*\}|<%=?\s*([\w.]+)\s*%>|%\(([\w.]+)\)[sd]/g;
var wrapXml = (p) => p.replace(VAR_RE, (m, ...g) => {
  const name = g.slice(0, 5).find(Boolean);
  const tag = name.replace(/\W/g, "_");
  return new RegExp(`<${tag}\\b`).test(p) ? m : `<${tag}>
${m}
</${tag}>`;
});
var TRANSFORMS = {
  "ANTH-ROLE-001": {
    technique: "add-role",
    apply: (p) => `You are an expert assistant specialized in this task.

${p}`
  },
  "ANTH-FMT-001": {
    technique: "specify-output-format",
    apply: (p) => `${p}

Format your response exactly as requested; if a structured result is implied, return valid JSON only.`
  },
  "ANTH-XML-001": { technique: "wrap-xml", apply: wrapXml },
  "GUARD-SEP-003": { technique: "wrap-xml", apply: wrapXml },
  "ANTH-SHOT-001": {
    technique: "add-examples",
    apply: (p) => `${p}

<example>
<input>EXAMPLE INPUT</input>
<output>IDEAL OUTPUT</output>
</example>`
  },
  "ANTH-POS-001": {
    technique: "positive-framing",
    apply: (p) => `${p}

(Express the constraints above as positive instructions \u2014 state what to do.)`
  },
  "LINT-STOP-002": {
    technique: "add-stop-conditions",
    apply: (p) => `${p}

Stop once the task is complete or after a reasonable number of attempts.`
  },
  "GUARD-IDK-001": {
    technique: "allow-idk",
    apply: (p) => `${p}

If the context does not contain the answer, reply "I don't know" rather than guessing.`
  },
  "GUARD-CITE-002": {
    technique: "require-citations",
    apply: (p) => `${p}

Support every factual claim with a direct quote or citation from the provided sources.`
  }
};
function proposeVariations(prompt, ctx = {}) {
  const { findings } = lintPrompt(prompt, ctx);
  const variations = [{ id: "baseline", technique: "baseline", prompt }];
  const seen = /* @__PURE__ */ new Set();
  const applied = [];
  for (const f of findings) {
    const t = TRANSFORMS[f.id];
    if (!t || seen.has(t.technique)) continue;
    seen.add(t.technique);
    applied.push(t);
    variations.push({ id: t.technique, technique: t.technique, prompt: t.apply(prompt), addresses: f.id });
  }
  if (applied.length > 1) {
    const combined = applied.reduce((p, t) => t.apply(p), prompt);
    variations.push({ id: "all-improvements", technique: "all-improvements", prompt: combined });
  }
  return variations;
}
function selectWinner(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0)
    throw new Error("selectWinner: candidates must be a non-empty array");
  const baseline = candidates.find((s) => s.id === "baseline");
  if (!baseline)
    throw new Error('selectWinner: candidates must include a "baseline" row to anchor regression detection');
  const { winner, escalate, ranking } = pickWinner(candidates);
  const winnerRow = winner ? candidates.find((s) => s.id === winner) : null;
  const regression = !!winnerRow && winnerRow.id !== "baseline" && winnerRow.total < baseline.total;
  return {
    winner: winner ?? null,
    escalate,
    regression,
    winnerPrompt: winnerRow ? winnerRow.prompt ?? null : null,
    baselineScore: baseline.total,
    ranking,
    candidates
  };
}

// src/prompt-scan.js
import { readdir as readdir11, readFile as readFile12 } from "node:fs/promises";
import { join as join17, relative as relative3, extname } from "node:path";

// src/prompt-discover.js
var PROMPT_EXT = /\.(prompt|prompt\.md|tmpl)$/i;
var PROMPT_DIR = /(^|\/)prompts\//i;
var MD_EXT = /\.(md|markdown|mdx|txt)$/i;
var PROMPT_DOC_DIR = /(^|\/)(?:\.claude|plugin)\/(?:agents|commands|skills|builtins|output-styles)\/|(^|\/)prompts\//i;
var NON_PROMPT_DIR = /(^|\/)(?:\.github|docs|website|node_modules)\//i;
var ASSIGN = /\b(system|systemprompt|prompt|instructions|persona)\s*[:=]\s*`([\s\S]*?)`/gi;
var MIN_PROMPT_LEN = 40;
function stripFrontmatter(content) {
  const str = String(content);
  const m = matchFrontmatter(str);
  return m ? m.rest : str;
}
function isPromptFile(path) {
  return PROMPT_EXT.test(path) || PROMPT_DIR.test(path);
}
function isPromptDoc(path, content) {
  if (!MD_EXT.test(path)) return false;
  if (NON_PROMPT_DIR.test(path)) return false;
  if (PROMPT_DOC_DIR.test(path)) return true;
  const fm = matchFrontmatter(content)?.raw || "";
  return /\bname:\s*\S/.test(fm) && /\bdescription:\s*\S/.test(fm);
}
function discoverPrompts(files = []) {
  const found = [];
  for (const { path, content } of files) {
    if (!content) continue;
    if (isPromptFile(path)) {
      const text = stripFrontmatter(content);
      if (text.trim().length > 0)
        found.push({ file: path, kind: "prompt-file", text });
      continue;
    }
    if (isPromptDoc(path, content)) {
      const text = stripFrontmatter(content).trim();
      if (text.length >= MIN_PROMPT_LEN)
        found.push({ file: path, kind: "prompt-doc", text });
      continue;
    }
    ASSIGN.lastIndex = 0;
    let m;
    while ((m = ASSIGN.exec(content)) !== null) {
      const text = m[2];
      if (text.trim().length >= MIN_PROMPT_LEN)
        found.push({ file: path, kind: "system-prompt", identifier: m[1], text });
    }
  }
  return found;
}

// src/prompt-scan.js
var SCAN_SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".worktrees",
  ".muster",
  "vendor",
  "__pycache__"
]);
var SCAN_TEXT_EXT = /* @__PURE__ */ new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".java",
  ".md",
  ".txt",
  ".prompt",
  ".tmpl",
  ".json",
  ".yaml",
  ".yml"
]);
var SCAN_MAX_FILE = 256 * 1024;
var SCAN_MAX_FILES = 5e3;
async function collectScanFiles(root) {
  const files = [];
  async function walk(dir) {
    if (files.length >= SCAN_MAX_FILES) return;
    let ents;
    try {
      ents = await readdir11(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (files.length >= SCAN_MAX_FILES) return;
      const full = join17(dir, e.name);
      if (e.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(e.name)) await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const isPromptName = /\.(prompt|tmpl)$/i.test(e.name);
      if (!SCAN_TEXT_EXT.has(extname(e.name).toLowerCase()) && !isPromptName) continue;
      let content;
      try {
        content = await readFile12(full, "utf8");
      } catch {
        continue;
      }
      if (content.length > SCAN_MAX_FILE) continue;
      files.push({ path: relative3(root, full), content });
    }
  }
  await walk(root);
  return files;
}
async function scanRepoPrompts(root) {
  const files = await collectScanFiles(root);
  const reviewed = discoverPrompts(files).map((p) => {
    const genre = p.kind === "prompt-file" ? "task" : "system";
    const { findings, total, passing, weakest } = lintPrompt(p.text, { genre });
    return {
      file: p.file,
      kind: p.kind,
      identifier: p.identifier,
      genre,
      passing,
      total,
      weakest: weakest?.criterion ?? null,
      findings: findings.map((f) => ({ id: f.id, severity: f.severity, fix: f.fix }))
    };
  });
  const failing = reviewed.filter((r) => !r.passing);
  return {
    scannedFiles: files.length,
    promptCount: reviewed.length,
    passing: reviewed.length - failing.length,
    failing: failing.length,
    truncated: files.length >= SCAN_MAX_FILES,
    prompts: reviewed
  };
}

// src/env-util.js
function isPlainObject(x) {
  return x !== null && x !== void 0 && typeof x === "object" && !Array.isArray(x);
}
function envInt(name, { min = 0, def }, env = process.env) {
  const raw = env[name];
  if (raw === void 0 || raw === "") return def;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return def;
  const n = parseInt(trimmed, 10);
  if (n < min) return def;
  return n;
}

// src/fusion.js
var REQUIRED_ARRAY_KEYS = [
  "consensus",
  "contradictions",
  "partialCoverage",
  "uniqueInsights",
  "blindSpots"
];
function validateFusionMap(map) {
  if (!isPlainObject(map)) {
    return { ok: false, errors: ["fusionMap: must be a non-null, non-array object"] };
  }
  const errors = [];
  for (const key of REQUIRED_ARRAY_KEYS) {
    if (!(key in map)) {
      errors.push(`${key}: required array is missing`);
    } else if (!Array.isArray(map[key])) {
      errors.push(`${key}: must be an array`);
    }
  }
  return { ok: errors.length === 0, errors };
}
function stableHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h << 5) + h ^ str.charCodeAt(i);
  return h >>> 0;
}
function minDisagreementThreshold() {
  return envInt("MUSTER_FUSE_MIN_DISAGREEMENT", { min: 0, def: 1 });
}
function topKLimit() {
  return envInt("MUSTER_FUSE_TOPK", { min: 1, def: 3 });
}
function fuse(candidates, map, opts = {}) {
  if (!Array.isArray(candidates)) {
    return { mode: "fallback", reason: "invalid-candidates", winner: pickWinner([]) };
  }
  const validation = validateFusionMap(map);
  if (!validation.ok) {
    return { mode: "fallback", reason: "invalid-map", winner: pickWinner(candidates) };
  }
  const passing = candidates.filter((c) => c.passing);
  if (passing.length <= 1) {
    return {
      mode: "fallback",
      reason: "single-or-none-passing",
      winner: pickWinner(candidates)
    };
  }
  const disagreementScore = map.contradictions.length + map.partialCoverage.length + map.uniqueInsights.length + map.blindSpots.length;
  const threshold = minDisagreementThreshold();
  if (disagreementScore < threshold) {
    return {
      mode: "fallback",
      reason: "candidates-agree",
      winner: pickWinner(candidates)
    };
  }
  const K = Math.min(topKLimit(), passing.length);
  const ranked = [...passing].sort(
    (a, b) => b.total - a.total || String(a.id).localeCompare(String(b.id))
  );
  const topKRows = ranked.slice(0, K);
  const ordered = [...topKRows].sort(
    (a, b) => stableHash(String(a.id)) - stableHash(String(b.id))
  );
  const references = ordered.map((c, i) => ({
    index: i + 1,
    content: c.content ?? c.text ?? "[content unavailable]"
  }));
  return {
    mode: "fuse",
    reason: "fusion",
    topK: ordered.map((c) => c.id),
    synthesizerInput: {
      references,
      fusionMap: map
    }
  };
}

// src/advisor.js
function validateAdviceRequest(req) {
  if (!isPlainObject(req)) {
    return { ok: false, errors: ["request: must be a non-null, non-array object"] };
  }
  const errors = [];
  if (!("question" in req)) {
    errors.push("question: required field is missing");
  } else if (typeof req.question !== "string" || req.question.trim() === "") {
    errors.push("question: must be a non-empty string");
  }
  if (!("context" in req)) {
    errors.push("context: required field is missing");
  } else if (typeof req.context !== "string") {
    errors.push("context: must be a string");
  }
  if (!("decisionType" in req)) {
    errors.push("decisionType: required field is missing");
  } else if (typeof req.decisionType !== "string") {
    errors.push("decisionType: must be a string");
  }
  if ("options" in req && !Array.isArray(req.options)) {
    errors.push("options: must be an array when present");
  }
  return { ok: errors.length === 0, errors };
}

// src/scope.js
import { readFile as readFile13 } from "node:fs/promises";
import { isAbsolute as isAbsolute4, join as join18 } from "node:path";

// src/batch-plan.js
import { isAbsolute as isAbsolute3 } from "node:path";
var FILE_TOKEN_RE = /\.[^\s./\\]+$/;
var WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
var WINDOWS_UNC_RE = /^\\/;
function parseBacklogRef(text) {
  if (typeof text !== "string") return { kind: "outcome" };
  const t = text.trim();
  if (t === "") return { kind: "outcome" };
  if (/^issues:/i.test(t)) {
    const label = t.slice("issues:".length).trim();
    if (!label) return { kind: "invalid", reason: "issues: ref with an empty label" };
    return { kind: "issues", label };
  }
  if (/^linear:/i.test(t)) {
    const key = t.slice("linear:".length).trim();
    if (!key) return { kind: "invalid", reason: "linear: ref with an empty team key or project" };
    return { kind: "linear", key };
  }
  if (!/\s/.test(t) && FILE_TOKEN_RE.test(t)) {
    if (isAbsolute3(t) || WINDOWS_DRIVE_RE.test(t) || WINDOWS_UNC_RE.test(t)) {
      return { kind: "invalid", reason: "file ref must not be an absolute path" };
    }
    if (t.includes("..")) {
      return { kind: "invalid", reason: "file ref must not contain a '..' path segment" };
    }
    return { kind: "file", path: t };
  }
  return { kind: "outcome" };
}

// src/scope.js
var UNCHECKED_ITEM_RE = /^- \[ \] /;
var SIGNAL_EXCERPT_MAX = 80;
var ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
var BIDI_CONTROL_RE = /[‎‏؜‪-‮⁦-⁩]/g;
function sanitizeForSignal(text) {
  const stripped = String(text).replace(ANSI_ESCAPE_RE, "").replace(BIDI_CONTROL_RE, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SIGNAL_EXCERPT_MAX) return collapsed;
  return `${collapsed.slice(0, SIGNAL_EXCERPT_MAX - 1)}\u2026`;
}
function countUncheckedItems(content) {
  if (typeof content !== "string") return 0;
  let n = 0;
  for (const line of content.split(/\r?\n/)) {
    if (UNCHECKED_ITEM_RE.test(line.replace(/^\s+/, ""))) n++;
  }
  return n;
}
var WINDOWS_DRIVE_RE2 = /^[A-Za-z]:[\\/]/;
var WINDOWS_UNC_RE2 = /^\\/;
function isTraversalUnsafe(rawSegment) {
  return typeof rawSegment !== "string" || isAbsolute4(rawSegment) || WINDOWS_DRIVE_RE2.test(rawSegment) || WINDOWS_UNC_RE2.test(rawSegment) || rawSegment.includes("..");
}
async function readBacklogCandidate(safeCwd, rawSegment) {
  if (isTraversalUnsafe(rawSegment)) return { readable: false, count: 0 };
  try {
    const content = await readFile13(join18(safeCwd, rawSegment), "utf8");
    return { readable: true, count: countUncheckedItems(content) };
  } catch {
    return { readable: false, count: 0 };
  }
}
async function detectScope({ cwd = process.cwd(), text = "" } = {}) {
  const safeCwd = typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
  const raw = typeof text === "string" ? text : "";
  const trimmed = raw.trim();
  const signals = [];
  const ref = parseBacklogRef(trimmed);
  if (ref.kind === "file") {
    signals.push(`"${sanitizeForSignal(ref.path)}" parses as a backlog file ref`);
  } else if (ref.kind === "issues") {
    signals.push(`"issues:${sanitizeForSignal(ref.label)}" parses as a GitHub-issues backlog ref`);
  } else if (ref.kind === "linear") {
    signals.push(`"linear:${sanitizeForSignal(ref.key)}" parses as a Linear backlog ref`);
  }
  if (trimmed !== "") {
    const { readable, count } = await readBacklogCandidate(safeCwd, trimmed);
    if (readable && count > 0) {
      signals.push(
        `"${sanitizeForSignal(trimmed)}" is a readable file with ${count} unchecked item${count === 1 ? "" : "s"}`
      );
    }
  }
  if (trimmed === "") {
    const { readable, count } = await readBacklogCandidate(safeCwd, join18(".muster", "backlog.md"));
    if (readable && count > 0) {
      signals.push(`.muster/backlog.md has ${count} unchecked item${count === 1 ? "" : "s"} (bare invocation)`);
    }
  }
  if (signals.length > 0) {
    return { scope: "backlog", signals };
  }
  if (trimmed !== "") {
    const excerpt = sanitizeForSignal(trimmed);
    if (ref.kind === "invalid") {
      return {
        scope: "item",
        signals: [
          `"${excerpt}" looks like a malformed backlog reference \u2014 treating as an outcome; check the ref syntax if you meant a backlog`
        ]
      };
    }
    return { scope: "item", signals: [`"${excerpt}" is an outcome, not a backlog ref`] };
  }
  return { scope: "ambiguous", signals: ["empty invocation and no live backlog found at .muster/backlog.md"] };
}

// src/cli.js
var CATALOG_DIR = new URL("../catalog/", import.meta.url);
function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
function fail(msg) {
  process.stderr.write(`muster: ${msg}
`);
  process.exit(1);
}
var MAX_STDIN_BYTES = 1048576;
function readStdin() {
  return new Promise((resolve3, reject) => {
    let d = "", bytes = 0;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      bytes += Buffer.byteLength(c, "utf8");
      if (bytes > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error(`stdin exceeds ${MAX_STDIN_BYTES} byte limit`));
        return;
      }
      d += c;
    });
    process.stdin.on("end", () => resolve3(d));
    process.stdin.on("error", reject);
  });
}
var readText = async (arg) => !arg || arg === "-" || arg.startsWith("--") ? await readStdin() : await readFile14(arg, "utf8");
async function resolveModeCapabilities(args) {
  const catalog = await loadCatalog(CATALOG_DIR);
  const codex = args.includes("--codex");
  const installed = codex ? await readCodexInventory({ cwd: process.cwd() }) : await readInstalled(homedir9());
  return resolveCapabilities(codex ? adaptCatalogForCodex(catalog, installed) : catalog, installed);
}
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "detect") {
      out(await detectProject(rest[0] || process.cwd()));
    } else if (cmd === "capabilities") {
      const catalog = await loadCatalog(CATALOG_DIR);
      const home = rest.find((a) => !a.startsWith("-")) || homedir9();
      let installed;
      if (rest.includes("--codex")) {
        installed = await readCodexInventory({ cwd: process.cwd() });
      } else if (rest.includes("--cowork")) {
        const declared = (flagValue(rest, "--connectors") || process.env.MUSTER_COWORK_CONNECTORS || "").split(",").map((s) => s.trim()).filter(Boolean);
        installed = await readInstalledCowork(home, { declaredConnectors: declared });
      } else {
        installed = await readInstalled(home);
      }
      out(resolveCapabilities(rest.includes("--codex") ? adaptCatalogForCodex(catalog, installed) : catalog, installed));
    } else if (cmd === "match" && rest.includes("--skills")) {
      const task = flagValue(rest, "--skills");
      if (!task) fail("match --skills <task>: missing task");
      const catalog = await loadCatalog(CATALOG_DIR);
      const codex = rest.includes("--codex");
      const installed = codex ? await readCodexInventory({ cwd: process.cwd() }) : await readInstalled(homedir9());
      const effectiveCatalog = codex ? adaptCatalogForCodex(catalog, installed) : catalog;
      const { skills } = resolveCapabilities(effectiveCatalog, installed);
      const ranked = matchSkills(task, skills);
      const stackArg = flagValue(rest, "--stack");
      const signals = stackArg ? {
        frameworks: stackArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
        languages: [],
        keywords: stackArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      } : signalsFromTask(task);
      const suggested = suggestSkillsForStack(signals, skills);
      out({ ranked, suggested });
    } else if (cmd === "match") {
      const args = rest.filter((arg) => arg !== "--codex");
      if (!args[0]) fail("match <task>: missing task");
      const catalog = await loadCatalog(CATALOG_DIR);
      const codex = rest.includes("--codex");
      const installed = codex ? await readCodexInventory({ cwd: process.cwd() }) : await readInstalled(homedir9());
      out(matchProviders(args[0], codex ? adaptCatalogForCodex(catalog, installed) : catalog, installed));
    } else if (cmd === "manifest" && rest[0] === "validate") {
      const args = rest.filter((arg) => arg !== "--codex");
      const file = requireArg(args, 1, "manifest validate <file>: missing file path", fail);
      const obj = JSON.parse(await readFile14(file, "utf8"));
      const r = validateManifest(obj);
      const catalog = await loadCatalog(CATALOG_DIR);
      const codex = rest.includes("--codex");
      const installed = codex ? await readCodexInventory({ cwd: process.cwd() }) : await readInstalled(homedir9());
      const effectiveCatalog = codex ? adaptCatalogForCodex(catalog, installed) : catalog;
      const { skills } = resolveCapabilities(effectiveCatalog, installed);
      const warnings = manifestWarnings(obj, skills);
      const unresolved = codex ? warnings.filter((warning) => warning.includes("not found in resolveCapabilities().skills")) : [];
      const remainingWarnings = warnings.filter((warning) => !unresolved.includes(warning));
      const result = unresolved.length ? { ok: false, errors: [...r.errors, ...unresolved], ...remainingWarnings.length ? { warnings: remainingWarnings } : {} } : warnings.length ? { ...r, warnings } : r;
      out(result);
      if (!result.ok) process.exit(2);
    } else if (cmd === "memory" && rest[0] === "write") {
      const dir = requireArg(rest, 1, "memory write <dir> <entry.json>: missing args", fail);
      const entryFile = requireArg(rest, 2, "memory write <dir> <entry.json>: missing args", fail);
      const entry = JSON.parse(await readFile14(entryFile, "utf8"));
      await writeMemory(dir, entry);
      out({ ok: true });
    } else if (cmd === "memory" && rest[0] === "read") {
      if (!rest[1]) fail("memory read <dir> [query]: missing dir");
      out(await readMemory(rest[1], rest[2] || ""));
    } else if (cmd === "wave") {
      const file = requireArg(rest, 0, "wave <manifest.json>: missing file path", fail);
      const m = JSON.parse(await readFile14(file, "utf8"));
      if (!Array.isArray(m.plan)) fail("wave: manifest has no 'plan' array");
      out(computeWaves(m.plan));
    } else if (cmd === "next") {
      const file = requireArg(rest, 0, "next <manifest.json> [--done a,b]: missing file path", fail);
      const m = JSON.parse(await readFile14(file, "utf8"));
      if (!Array.isArray(m.plan)) fail("next: manifest has no 'plan' array");
      const doneArg = flagValue(rest, "--done");
      out(nextTasks(m.plan, doneArg ? doneArg.split(",") : []));
    } else if (cmd === "sprint-waves") {
      const file = requireArg(rest, 0, "sprint-waves <backlog.md>: missing file path", fail);
      const content = await readFile14(file, "utf8");
      const r = computeSprintWaves(content);
      out(r);
      if (!r.ok) process.exit(2);
    } else if (cmd === "tally") {
      const file = requireArg(rest, 0, "tally <verdicts.json>: missing file path", fail);
      out(tallyReview(JSON.parse(await readFile14(file, "utf8"))));
    } else if (cmd === "pick") {
      const file = requireArg(rest, 0, "pick <candidates.json>: missing file path", fail);
      out(pickWinner(JSON.parse(await readFile14(file, "utf8"))));
    } else if (cmd === "fuse") {
      const candidatesFile = requireArg(rest, 0, "fuse <candidates.json> <fusion-map.json>: missing candidates file path", fail);
      const mapFile = requireArg(rest, 1, "fuse <candidates.json> <fusion-map.json>: missing fusion-map file path", fail);
      const candidates = JSON.parse(await readFile14(candidatesFile, "utf8"));
      const map = JSON.parse(await readFile14(mapFile, "utf8"));
      out(fuse(candidates, map));
    } else if (cmd === "advise") {
      const file = requireArg(rest, 0, "advise <advice-request.json>: missing file path", fail);
      const req = JSON.parse(await readFile14(file, "utf8"));
      const v = validateAdviceRequest(req);
      if (!v.ok) fail(v.errors.join("\n"));
      out({ advisorModel: modelForRole("advisor"), request: req });
    } else if (cmd === "vendor") {
      const manifestUrl = new URL("../vendor/manifest.yaml", import.meta.url);
      const manifest = (0, import_yaml6.parse)(await readFile14(manifestUrl, "utf8"));
      const v = validateVendorManifest(manifest);
      if (!v.ok) {
        process.stderr.write(`muster: ${v.errors.join("\n")}
`);
        process.exit(2);
      }
      const repoRoot = dirFromImportMeta(import.meta.url, "../");
      const res = await runVendor({ repoRoot, manifest });
      res.warnings.forEach((w) => process.stderr.write(`warn: ${w}
`));
      out({ vendored: res.count, warnings: res.warnings.length });
    } else if (cmd === "setup") {
      out(await scaffoldProject(rest[0] || process.cwd()));
    } else if (cmd === "plan-checklist") {
      const file = requireArg(rest, 0, "plan-checklist <manifest.json> [--done a,b]: missing file path", fail);
      const m = JSON.parse(await readFile14(file, "utf8"));
      const doneArg = flagValue(rest, "--done");
      const done = doneArg ? doneArg.split(",") : [];
      process.stdout.write(renderPlanChecklist(m.plan || [], done) + "\n");
    } else if (cmd === "score") {
      const file = requireArg(rest, 0, "score <file.json>: missing file path ({scores, gate})", fail);
      const { scores, gate } = JSON.parse(await readFile14(file, "utf8"));
      out(scoreArtifact(scores, gate));
    } else if (cmd === "prompt") {
      const sub = rest[0];
      if (sub === "lint" && rest.includes("--chat")) {
        const file = flagValue(rest, "--chat");
        const messages = JSON.parse(file ? await readFile14(file, "utf8") : await readStdin());
        out(lintChat(messages));
      } else if (sub === "lint" && rest.includes("--workflow")) {
        const file = flagValue(rest, "--workflow");
        const prompts = JSON.parse(file ? await readFile14(file, "utf8") : await readStdin());
        out(lintWorkflow(prompts));
      } else if (sub === "lint" || sub === "variations") {
        const text = await readText(rest[1]);
        const ctx = { isAgent: rest.includes("--agent"), hasTools: rest.includes("--tools") };
        if (rest.includes("--system")) ctx.genre = "system";
        else if (rest.includes("--task")) ctx.genre = "task";
        const schemaFile = flagValue(rest, "--tool-schema");
        if (schemaFile) {
          const parsed = JSON.parse(await readFile14(schemaFile, "utf8"));
          ctx.tools = Array.isArray(parsed) ? parsed : parsed.tools;
          ctx.isAgent = true;
        }
        out(sub === "lint" ? lintPrompt(text, ctx) : proposeVariations(text, ctx));
      } else if (sub === "eval") {
        const file = requireArg(rest, 1, "prompt eval <suite.json>: missing suite ({dataset:[{output,format?,graderResponse?}], passThreshold?})", fail);
        const suite = JSON.parse(await readFile14(file, "utf8"));
        out(gradeCollected(suite));
      } else if (sub === "optimize") {
        const file = requireArg(rest, 1, "prompt optimize <file.json>: missing file ({candidates:[{id,prompt?,total,passing}]})", fail);
        const { candidates } = JSON.parse(await readFile14(file, "utf8"));
        out(selectWinner(candidates));
      } else if (sub === "scan") {
        out(await scanRepoPrompts(rest[1] || process.cwd()));
      } else {
        fail("prompt <lint|variations|eval|optimize|scan> [file|dir|-] [--agent] [--tools] [--tool-schema <f>] [--chat <f>] [--workflow <f>]");
      }
    } else if (cmd === "humanize-score") {
      const text = await readText(rest[0]);
      const threshold = Number(flagValue(rest, "--threshold")) || void 0;
      out(scoreHumanness(text, threshold ? { threshold } : {}));
    } else if (cmd === "citation-check") {
      const text = await readText(rest[0]);
      const r = checkCitations(text);
      out(r);
      if (!r.ok) process.exit(2);
    } else if (cmd === "prioritize") {
      const file = requireArg(rest, 0, "prioritize <file> [--model rice|ice|wsjf|weighted]: missing file", fail);
      const parsed = JSON.parse(await readFile14(file, "utf8"));
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      const model = flagValue(rest, "--model") || (Array.isArray(parsed) ? "rice" : parsed.model || "rice");
      out(prioritize(items, model));
    } else if (cmd === "pipeline") {
      if (!rest[0]) fail("pipeline <domain|id>: missing arg");
      const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
      out(pipelineForDomain(ps, rest[0]) || ps.find((p) => p.id === rest[0]) || null);
    } else if (cmd === "domain") {
      const { override, outcome } = parseDomainArgs(rest);
      if (!outcome) fail("domain <outcome> [--domain x]: missing outcome");
      out(classifyDomain(outcome, await detectProject(process.cwd()), override));
    } else if (cmd === "route") {
      if (!rest[0]) fail("route <outcome>: missing outcome");
      const outcome = rest.join(" ");
      const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
      const { domain } = classifyDomain(outcome, await detectProject(process.cwd()));
      const p = routePipeline(ps, outcome, domain);
      out({ domain, pipeline: p ? p.id : null });
    } else if (cmd === "diagnose") {
      const args = rest.filter((arg) => arg !== "--codex");
      const ci = args.includes("--ci");
      let input;
      if (ci) {
        const ciFile = flagValue(args, "--ci");
        if (!ciFile) fail("diagnose --ci <file>: missing file");
        input = await readFile14(ciFile, "utf8");
      } else input = args.join(" ");
      if (!input || !input.trim()) fail("diagnose <symptom> | --ci <file>: missing input");
      const failure = classifyFailure(input, { ci });
      const caps = await resolveModeCapabilities(rest);
      out({ mode: failure.mode, manifest: buildDiagnoseManifest(failure, caps) });
    } else if (cmd === "audit") {
      const args = rest.filter((arg) => arg !== "--codex");
      const caps = await resolveModeCapabilities(rest);
      const prompting = await hasPromptingSignal(args[0] || process.cwd());
      out(buildAuditManifest(caps, { prompting }));
    } else if (cmd === "issue") {
      if (!rest[0]) fail("issue <ref>: missing #N | number | issue-url");
      if (parseIssueRef(rest[0]).kind !== "issue") fail("not a GitHub issue reference: " + rest[0]);
      out(await resolveIssue(rest[0]));
    } else if (cmd === "assess") {
      const codex = rest.includes("--codex");
      const args = rest.filter((arg) => arg !== "--codex");
      if (!args[0]) fail("assess <outcome>: missing outcome");
      out(assessOutcome(args[0], { codex }));
    } else if (cmd === "steer") {
      if (!rest[0]) fail("steer <message>: missing message");
      out(classifySteer(rest.join(" ")));
    } else if (cmd === "scope") {
      out(await detectScope({ cwd: process.cwd(), text: rest.join(" ") }));
    } else if (cmd === "doctor") {
      const r = rest.includes("--codex") ? await runCodexDoctor({ root: new URL("../", import.meta.url) }) : await runDoctor({ root: new URL("../", import.meta.url) });
      out(r);
      if (!r.ok) process.exit(2);
    } else if (cmd === "scratchpad") {
      if (!rest[0]) fail("scratchpad <runId> [dir]: missing runId");
      out(await initScratchpad(rest[1] || ".muster", rest[0]));
    } else if (cmd === "profile") {
      out(await readProfile());
    } else if (cmd === "install") {
      if (rest[0] === "codex") {
        out(await runCodexInstall({ scope: flagValue(rest, "--scope") || "project", dryRun: rest.includes("--dry-run") }));
      } else out(await runInstall({ home: rest[0] || homedir9() }));
    } else if (cmd === "uninstall") {
      if (rest[0] === "codex") {
        out(await runCodexUninstall({ scope: flagValue(rest, "--scope") || "project", dryRun: rest.includes("--dry-run") }));
      } else out(await runUninstall({ home: rest[0] || homedir9() }));
    } else if (cmd === "signals") {
      const dir = rest[0] || process.cwd();
      const profile = await detectProject(dir);
      const caps = resolveCapabilities(await loadCatalog(CATALOG_DIR), await readInstalled(homedir9()));
      const sig = buildSignals(profile, caps);
      await mkdir7(".muster", { recursive: true });
      await writeFile8(".muster/signals.json", JSON.stringify(sig, null, 2));
      out(sig);
    } else {
      fail(`unknown command: ${[cmd, ...rest].join(" ")}
Usage: muster <detect|capabilities [--cowork] [--codex]|match [--skills] <task> [--stack <csv>]|manifest validate <file>|wave <file>|next <manifest.json> [--done a,b]|sprint-waves <backlog.md>|tally <file>|pick <file>|fuse <candidates.json> <fusion-map.json>|advise <advice-request.json>|memory read|write ...|vendor|setup [dir]|plan-checklist <file>|domain <outcome>|pipeline <domain|id>|route <outcome>|score <file>|prompt <lint|variations|eval|optimize|scan> [file|dir]|humanize-score <file>|citation-check <file>|prioritize <file> [--model rice|ice|wsjf|weighted]|diagnose <symptom>|--ci <file>|audit|issue <ref>|assess <outcome>|steer <message>|scope [text]|doctor [--codex]|scratchpad <runId>|profile|install codex [--scope project-or-user] [--dry-run]|uninstall codex [--scope project-or-user] [--dry-run]|signals [dir]>`);
    }
  } catch (e) {
    fail(formatError(e));
  }
}
await main();
