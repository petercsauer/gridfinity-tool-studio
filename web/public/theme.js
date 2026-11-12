/* Appearance: follows prefers-color-scheme; ?theme=light|dark overrides it (testing).
   A classic script so the theme is set before first paint. */
(function(){
  var d=document.documentElement, q=new URLSearchParams(location.search).get('theme'),
      mq=matchMedia('(prefers-color-scheme: dark)');
  function apply(){
    var t=(q==='light'||q==='dark')?q:(mq.matches?'dark':'light');
    if(d.dataset.theme!==t){ d.dataset.theme=t; window.dispatchEvent(new Event('themechange')); }
  }
  apply(); mq.addEventListener('change',apply);
})();
