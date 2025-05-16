// SPDX-License-Identifier: MIT
// Copyright © 2021 fvtt-lib-wrapper Rui Pinheiro

'use strict';

// A shim for the libWrapper library
export let libWrapper = undefined;

export const VERSIONS = [1, 12, 2];
export const TGT_SPLIT_RE = new RegExp("([^.[]+|\\[(\\d+)\\])\\.", "g");
export const LIB_MODULE_NAME = "lib-wrapper";
export const WRAPPER_MODULE_NAME = "magecraft-ability";

// Main module singleton
// eslint-disable-next-line no-var
var LibWrapperShim = class {
    static get is_fallback() { return true; }

    // Generate a ID for a specific hook/target combination
    static get_id(module, target, name) {
        return `${module}.${name}@${target}`;
    }

    static get_wrapper_name(id) {
        return `__${id.replace(/[^a-zA-Z0-9_]/g, '_')}_wrapper`;
    }

    static get_module_id(id) {
        return id.split('.', 1)[0];
    }

    static get_target_name(id) {
        return id.slice(this.get_module_id(id).length + 1);
    }

    static get_split_module_target(id) {
        const moduleName = this.get_module_id(id);
        const targetName = this.get_target_name(id);
        return [moduleName, targetName];
    }

    static get_method_key(target) {
        // Split module / target
        let methods = [];
        let match;
        // eslint-disable-next-line no-cond-assign
        while (match = TGT_SPLIT_RE.exec(target + '.')) {
            if (match[2] !== undefined) {
                methods.push(parseInt(match[2]));
            } else {
                methods.push(match[1]);
            }
        }
        return methods;
    }

    // Get the raw wrapped method
    static _get_wrapped_method(owner, methods, depth = 0) {
        if (methods === undefined)
            return owner;
        if (methods.length <= depth)
            return owner;

        let key = methods[depth];
        if (typeof key === 'number' && Array.isArray(owner))
            key = Math.min(key, owner.length - 1);

        return this._get_wrapped_method(owner[key], methods, depth + 1);
    }

    static _traverse_object(owner, methods, create = false, depth = 0) {
        if (methods.length <= depth)
            return { owner, methods: [] };

        let key = methods[depth];
        let is_idx = typeof key === 'number';
        // edge case: key is a number and the property is an array, but it might be a property assigned a number
        // (which should be accessed via ['number'] syntax, not [number])
        // prefer the property name to the array index
        const ambiguous = !create && owner[key] !== undefined && is_idx && !Array.isArray(owner);
        if (ambiguous) {
            try {
                // access by property name, not by array index
                // eslint-disable-next-line no-new-func
                const ac_res = (new Function(`return arguments[0][${JSON.stringify(key)}]`))(owner);
                if (ac_res !== owner[key]) {
                    console.warn(`libWrapper Shim: traversal ambiguity in method key ${methods.join('.')}, depth = ${depth}: Property ${key} exists but is different from index ${key}. Attempting property.`);
                }
            } catch (e) {
                console.warn(`libWrapper Shim: traversal ambiguity in method key ${methods.join('.')}, depth = ${depth}: Property ${key} exists but is different from index ${key}. Attempting property, got error:`, e);
            }
        }

        // if owner[key] is already an array, then we're going to assume indexing into an array...
        const use_property = ambiguous && !Array.isArray(owner);

        const orig_key = key;
        key = use_property ? key : (is_idx ? Math.min(key, Array.isArray(owner) ? owner.length : Infinity) : key);

        if (key === undefined || (owner[key] === undefined && !create))
            return { owner, methods: methods.slice(depth) };

        // Create missing entries
        if (owner[key] === undefined) {
            // Decide what should be created
            let create_arr = false;
            if (depth + 1 < methods.length) { // If there is a next method
                create_arr = typeof methods[depth + 1] === 'number' || methods[depth + 1].match(/^\d+$/) !== null;
            }

            // Create it
            owner[key] = create_arr ? [] : {};
        }

        return this._traverse_object(owner[key], methods, create, depth + 1);
    }

    static get_wrapped_method(target) {
        const methods = this.get_method_key(target);
        const owner = (methods[0] === 'globalThis' || methods[0] === 'self' || methods[0] === 'window')
            ? globalThis
            : (globalThis[methods[0]] || {});
        return this._get_wrapped_method(owner, methods, 1);
    }

    // Create a wrapped method
    static _create_wrapper(method, wrapper, id, type = 'MIXED') {
        const libWrapperShim = this;

        // Create actual wrapper function
        let fn = null;
        switch (type) {
            case 'WRAPPER':
                fn = function () { return wrapper.call(this, method, ...arguments); };
                break;
            case 'MIXED':
                fn = function () { return wrapper.call(this, method.bind(this), ...arguments); };
                break;
            default:
            case 'OVERRIDE':
                fn = function () { return wrapper.call(this, ...arguments); };
                break;
        }

        // Copy original static properties
        if (method && typeof method === 'function') {
            for (const k of Object.getOwnPropertyNames(method)) {
                if (k === 'name' || k === 'length' || k === 'prototype')
                    continue;

                // Copy static property
                const descriptor = Object.getOwnPropertyDescriptor(method, k);

                // If it is a getter, re-define it on the wrapper
                if (descriptor.get || descriptor.set) {
                    Object.defineProperty(fn, k, {
                        get: descriptor.get,
                        set: descriptor.set
                    });
                } else {
                    fn[k] = method[k];
                }
            }

            // Copy prototype
            if (method.prototype) {
                fn.prototype = method.prototype;
            }
        }

        // Define special getter/setters, to help with debugging
        Object.defineProperty(fn, '__lib_wrapper_name', {
            value: id,
            writable: false
        });

        // Store in the wrapped method registry
        this._store_wrapper(id, { wrapper, method });

        return fn;
    }

    static _store_wrapper(id, { wrapper, method }) {
        // Get module and target name
        const [moduleName, targetName] = this.get_split_module_target(id);

        // Don't store shim wrappers
        if (moduleName === LIB_MODULE_NAME || moduleName === WRAPPER_MODULE_NAME)
            return;

        const module = globalThis.game?.modules?.get(moduleName);
        if (!module) {
            console.error(`libWrapper Shim: Module ${moduleName} not found`);
            return;
        }

        this.wrappers.push({
            id,
            module: moduleName,
            target: targetName,
            wrapper,
            method
        });
    }

    // Register new module wrapper
    register(module, target, fn, type = 'MIXED', { chain = null } = {}) {
        type = type.toUpperCase();
        if (chain !== null)
            throw new Error(`libWrapper Shim: 'chain' argument is not supported`);
        if (!['WRAPPER', 'MIXED', 'OVERRIDE'].includes(type))
            throw new Error(`libWrapper Shim: '${type}' is not a valid 'type' for libWrapper.register`);

        if (!module || !target || !fn)
            throw new Error(`libWrapper Shim: missing required argument for libWrapper.register(module, target, fn, type, { chain })`);

        // Get stored path
        const methods = this.get_method_key(target);
        if (methods.length < 2)
            throw new Error(`libWrapper Shim: invalid path '${target}'`);

        // Get/create owner object
        const owner_str = methods[0] === 'globalThis' || methods[0] === 'self' || methods[0] === 'window'
            ? globalThis
            : (globalThis[methods[0]] || {});
        // Shallow copy of methods
        const wrapper_methods = [...methods];
        const leaf_method = wrapper_methods.pop();
        const { owner, methods: tail } = this._traverse_object(owner_str, wrapper_methods, true, 1);
        if (typeof owner !== 'object')
            return console.error(`libWrapper Shim: could not find owner for ${target}`);
        if (tail.length > 0)
            return console.error(`libWrapper Shim: could not find owner for ${target} (${tail.join('.')})`);

        // If this is already a special wrapper/object, we need to back up the originals first
        const old_fn = owner[leaf_method];

        // If it doesn't exist, fail
        if (!old_fn || typeof old_fn === 'undefined')
            return console.error(`libWrapper Shim: could not find method '${leaf_method}' in ${wrapper_methods.join('.')}`);

        // Get unique ID for wrapper
        const id = this.get_id(module, target, fn.name);

        // Create wrapper
        const wrapped_fn = this._create_wrapper(old_fn, fn, id, type);

        // Set wrapper in owner object
        owner[leaf_method] = wrapped_fn;

        // Save original
        const wrapper_name = this.get_wrapper_name(id);
        owner[wrapper_name] = old_fn;

        // Done!
        return wrapped_fn;
    }

    // Unregister a wrapper
    unregister(module, target, fn) {
        if (!module || !target || !fn)
            throw new Error(`libWrapper Shim: missing required argument for libWrapper.unregister(module, target, fn)`);

        const id = this.get_id(module, target, fn.name);
        const wrapper_name = this.get_wrapper_name(id);

        // Get stored path
        const methods = this.get_method_key(target);
        if (methods.length < 2)
            throw new Error(`libWrapper Shim: invalid path '${target}'`);

        // Get/create owner object
        const owner_str = methods[0] === 'globalThis' || methods[0] === 'self' || methods[0] === 'window'
            ? globalThis
            : (globalThis[methods[0]] || {});
        // Shallow copy of methods
        const wrapper_methods = [...methods];
        const leaf_method = wrapper_methods.pop();
        const { owner, methods: tail } = this._traverse_object(owner_str, wrapper_methods, false, 1);
        if (typeof owner !== 'object')
            throw new Error(`libWrapper Shim: could not find owner for ${target}`);
        if (tail.length > 0)
            throw new Error(`libWrapper Shim: could not find owner for ${target} (${tail.join('.')})`);

        // If this isn't a special wrapper object, unregistering doesn't really make sense
        if (!owner[wrapper_name])
            throw new Error(`libWrapper Shim: ${target} is not wrapped`);

        // Remove wrapper
        owner[leaf_method] = owner[wrapper_name];
        delete owner[wrapper_name];
    }

    // Clear wrappers
    clear_module_wrappers(module) {
        if (!module)
            throw new Error(`libWrapper Shim: missing required argument for libWrapper.clear_module_wrappers(module)`);

        const wrappers = [...this.wrappers].filter(x => x.module === module);
        for (const wrapper of wrappers) {
            try {
                const fn = wrapper.wrapper;
                console.log(`libWrapper Shim: Removing wrapper for ${wrapper.id}`);
                this.unregister(wrapper.module, wrapper.target, fn);
            } catch (e) {
                console.error(`libWrapper Shim: Exception when unwrapping ${wrapper.id}`, e);
            }
        }
    }

    // Clear all wrappers
    clear_all_wrappers(priority_modules = [], notify = false) {
        for (const wrapper of [...this.wrappers]) {
            try {
                const fn = wrapper.wrapper;
                console.log(`libWrapper Shim: Removing wrapper for ${wrapper.id}`);
                this.unregister(wrapper.module, wrapper.target, fn);
            } catch (e) {
                console.error(`libWrapper Shim: Exception when unwrapping ${wrapper.id}`, e);
            }
        }
    }

    constructor() {
        this.wrappers = [];

        globalThis._libWrapperShim = this;
    }
};

// Initialize
Hooks.once('init', () => {
    libWrapper = new LibWrapperShim();
});