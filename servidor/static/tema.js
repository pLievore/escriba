/* Escriba: tema. Carregado no <head> antes do CSS para não piscar o tema errado.
   Grava sempre data-theme no <html>; o app.css tem um único bloco de tokens escuros. */
(function () {
  'use strict';
  var pref = 'sistema';
  try { pref = localStorage.getItem('mesa.tema') || 'sistema'; } catch (e) { /* sem armazenamento */ }
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function aplicar() {
    var t = (pref === 'escuro' || (pref === 'sistema' && mq && mq.matches)) ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
  }
  aplicar();
  if (mq) {
    var ouvir = function () { if (pref === 'sistema') aplicar(); };
    if (mq.addEventListener) mq.addEventListener('change', ouvir); else if (mq.addListener) mq.addListener(ouvir);
  }
  window.mesaTema = function (v) {
    pref = (v === 'claro' || v === 'escuro') ? v : 'sistema';
    try { localStorage.setItem('mesa.tema', pref); } catch (e) { /* sem armazenamento */ }
    aplicar();
  };
  window.mesaTemaAtual = function () { return pref; };
})();
