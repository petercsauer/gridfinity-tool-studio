// A Vite plugin that removes runtime code generation (new Function) from prebuilt Emscripten bundles, so the
// production Content-Security-Policy can leave out 'unsafe-eval'. Each patch swaps one generated-code helper for
// an equivalent closure; a patch whose source text isn't found fails the build, so a dependency upgrade can't
// silently bring eval back.
//
// - opencv.js (@techstark/opencv-js): embind's createJsInvoker (every bound function and method, built at module
//   init) and __emval_create_invoker (calls into JS values from C++).
// - heic-to: its CSP build already has no eval; it's only checked, so an upgrade can't bring eval back.
import type { Plugin } from 'vite';

/** Replace `find` (through the end of `until`, when given) with `replace`. */
interface Patch { find: string; until?: string; replace: string }

const OPENCV: Patch[] = [
  {
    // createJsInvoker(argTypes, isClassMethodFunc, returns, isAsync) returns a factory taking the closure args that
    // craftInvokerFunction builds: humanName, throwBindingError, invoker, fn, runDestructors, fromRetWire,
    // toClassParamWire, one toArgNWire per argument, then one destructor per argument that has one.
    find: 'function createJsInvoker(argTypes,isClassMethodFunc,returns,isAsync){',
    until: 'return new Function(args1,invokerFnBody)}',
    replace: 'function createJsInvoker(argTypes,isClassMethodFunc,returns,isAsync){var needsDestructorStack=usesDestructorStack(argTypes);var argCount=argTypes.length-2;'
      + 'var dtorAt=[];if(!needsDestructorStack){for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){if(argTypes[i].destructorFunction!==null)dtorAt.push(i)}}'
      + 'var first=isClassMethodFunc?2:1;'
      + 'return function(humanName,throwBindingError,invoker,fn,runDestructors,fromRetWire,toClassParamWire,...rest){'
      + 'var toArgWire=rest.slice(0,argCount),dtors=rest.slice(argCount);'
      + 'return function(...args){var destructors=needsDestructorStack?[]:null;var wired=[fn];var thisWired;'
      + 'if(isClassMethodFunc){thisWired=toClassParamWire(destructors,this);wired.push(thisWired)}'
      + 'for(var i=0;i<argCount;++i)wired.push(toArgWire[i](destructors,args[i]));'
      + 'var rv=invoker(...wired);'
      + 'if(needsDestructorStack){runDestructors(destructors)}else{for(var k=0;k<dtorAt.length;++k){var p=dtorAt[k];dtors[k](p===1?thisWired:wired[first+p-2])}}'
      + 'if(returns)return fromRetWire(rv)}}}',
  },
  {
    // kind 0: call the value, 1: call a named method on it, 2: construct it, 3: return the (single) argument.
    find: 'var invokerFunction=new Function(Object.keys(captures),functionBody)(...Object.values(captures));',
    replace: 'var invokerFunction=(handle,methodName,destructorsRef,args)=>{'
      + 'var a=argFromPtr.map((read,i)=>read(args+i*GenericWireTypeSize));var rv;'
      + 'switch(kind){case 0:rv=Emval.toValue(handle)(...a);break;case 1:rv=Emval.toValue(handle)[getStringOrSymbol(methodName)](...a);break;'
      + 'case 2:rv=new(Emval.toValue(handle))(...a);break;case 3:rv=a[a.length-1];break}'
      + 'if(!retType.isVoid)return emval_returnValue(toReturnWire,destructorsRef,rv)};',
  },
];

function apply(code: string, patches: Patch[], name: string): string {
  for (const { find, until, replace } of patches) {
    const at = code.indexOf(find);
    if (at < 0 || code.indexOf(find, at + 1) >= 0) throw new Error(`no-eval: expected exactly one match in ${name} for ${find.slice(0, 60)}…`);
    let end = at + find.length;
    if (until) {
      const u = code.indexOf(until, end);
      if (u < 0 || u - at > 4000) throw new Error(`no-eval: end of the patched code not found in ${name} (${until})`);
      end = u + until.length;
    }
    code = code.slice(0, at) + replace + code.slice(end);
  }
  if (/(?<![\w.$])Function(?=[(,])/.test(code)) {
    throw new Error(`no-eval: ${name} still constructs functions from strings`);
  }
  return code;
}

export function noEval(): Plugin {
  return {
    name: 'gts-no-eval',
    enforce: 'pre',
    transform(code, id) {
      if (/[\\/]@techstark[\\/]opencv-js[\\/]dist[\\/]opencv\.js$/.test(id)) return { code: apply(code, OPENCV, 'opencv.js'), map: null };
      if (/[\\/]heic-to[\\/]dist[\\/]csp[\\/]heic-to\.js$/.test(id)) return { code: apply(code, [], 'heic-to (csp)'), map: null };
      return null;
    },
  };
}
