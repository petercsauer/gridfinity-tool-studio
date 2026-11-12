// A Vite plugin that removes runtime code generation (new Function) from two prebuilt Emscripten bundles, so the
// production Content-Security-Policy can leave out 'unsafe-eval'. Each patch swaps one generated-code helper for
// an equivalent closure; a patch whose source text isn't found fails the build, so a dependency upgrade can't
// silently bring eval back.
//
// - opencv.js (@techstark/opencv-js): embind's createJsInvoker (every bound function and method, built at module
//   init) and __emval_create_invoker (calls into JS values from C++).
// - heic2any: libheif's createNamedFunction, craftInvokerFunction and makeDynCaller, inside the worker source it ships as a string.
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

// heic2any's worker is a string literal in the bundle, so its quotes appear escaped (\") here.
const HEIC2ANY: Patch[] = [
  {
    find: 'function QA(A,e){return A=YA(A),new Function(\\"body\\",\\"return function \\"+A+\'() {\\\\n    \\"use strict\\";    return body.apply(this, arguments);\\\\n};\\\\n\')(e)}',
    replace: 'function QA(A,e){return function(){return e.apply(this,arguments)}}',
  },
  {
    find: 'function QA(A,e){return A=YA(A=A||\\"function_\\"+new Date),new Function(\\"body\\",\\"return function \\"+A+\'() {\\\\n    \\"use strict\\";    return body.apply(this, arguments);\\\\n};\\\\n\')(e)}',
    replace: 'function QA(A,e){return function(){return e.apply(this,arguments)}}',
  },
  {
    // craftInvokerFunction(humanName, argTypes, classType, cppInvokerFunc, cppTargetFunc), older embind
    find: 'function xe(A,e,r,i,f){',
    until: 'He(Function,d).apply(null,k)}',
    replace: 'function xe(A,e,r,i,f){var n=e.length;n<2&&HA(\'argTypes array size mismatch!\');'
      + 'for(var t=null!==e[1]&&null!==r,o=!1,a=1;a<e.length;++a)if(null!==e[a]&&void 0===e[a].destructorFunction){o=!0;break}'
      + 'var c=\'void\'!==e[0].name;'
      + 'return function(){if(arguments.length!==n-2)HA(\'function \'+A+\' called with \'+arguments.length+\' arguments, expected \'+(n-2)+\' args!\');'
      + 'var s=o?[]:null,w=[f],th;if(t){th=e[1].toWireType(s,this);w.push(th)}'
      + 'for(var a=0;a<n-2;++a)w.push(e[a+2].toWireType(s,arguments[a]));'
      + 'var rv=i.apply(null,w);'
      + 'if(o)CA(s);else for(a=t?1:2;a<e.length;++a){if(null!==e[a].destructorFunction)e[a].destructorFunction(1===a?th:w[(t?2:1)+a-2])}'
      + 'if(c)return e[0].fromWireType(rv)}}',
  },
  {
    find: 'new Function(\\"dynCall\\",\\"rawFunction\\",i)(A,n)',
    replace: 'function(){var t=[n];for(var k=0;k<arguments.length;k++)t.push(arguments[k]);return A.apply(null,t)}',
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
      if (/[\\/]heic2any[\\/]dist[\\/]heic2any\.js$/.test(id)) return { code: apply(code, HEIC2ANY, 'heic2any.js'), map: null };
      return null;
    },
  };
}
