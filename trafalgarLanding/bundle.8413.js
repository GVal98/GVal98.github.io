!function(){"use strict";function t(t,e){for(var n=0;n<e.length;n++){var s=e[n];s.enumerable=s.enumerable||!1,s.configurable=!0,"value"in s&&(s.writable=!0),Object.defineProperty(t,s.key,s)}}var e=function(){function e(t,n){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),this.buttonClass=t,this.menuClass=n,this.visibleClass="".concat(n,"--visible"),this.hiddenClass="".concat(n,"--hidden")}var n,s;return n=e,(s=[{key:"init",value:function(){var t=this;this.getElements(),this.button.addEventListener("click",(function(){return t.toggle()}))}},{key:"getElements",value:function(){this.button=document.getElementsByClassName(this.buttonClass)[0],this.menu=document.getElementsByClassName(this.menuClass)[0]}},{key:"toggle",value:function(){this.menu.classList.toggle(this.visibleClass),this.menu.classList.toggle(this.hiddenClass)}}])&&t(n.prototype,s),e}();function n(t,e){if(t){if("string"==typeof t)return s(t,e);var n=Object.prototype.toString.call(t).slice(8,-1);return"Object"===n&&t.constructor&&(n=t.constructor.name),"Map"===n||"Set"===n?Array.from(t):"Arguments"===n||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)?s(t,e):void 0}}function s(t,e){(null==e||e>t.length)&&(e=t.length);for(var n=0,s=new Array(e);n<e;n++)s[n]=t[n];return s}function i(t,e){for(var n=0;n<e.length;n++){var s=e[n];s.enumerable=s.enumerable||!1,s.configurable=!0,"value"in s&&(s.writable=!0),Object.defineProperty(t,s.key,s)}}var r=function(){function t(e,n,s,i,r,a,o,l){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,t),this.sliderClass=e,this.containerClass=n,this.itemClass=s,this.backButtonClass=i,this.forwardButtonClass=r,this.selectorClass=a,this.buttonActiveClass=o,this.selectorActiveClass=l}var e,r;return e=t,(r=[{key:"init",value:function(){var t=this;this.getElements(),this.addEventListeners(),this.currentItem=1,this.lastItem=this.selectors.length,this.itemWidth=this.container.getBoundingClientRect().width,this.resizeObserver=new ResizeObserver((function(e){return t.resize(e[0].contentRect.width)})),this.resizeObserver.observe(this.container)}},{key:"getElements",value:function(){this.slider=document.getElementsByClassName(this.sliderClass)[0],this.container=this.slider.getElementsByClassName(this.containerClass)[0],this.items=this.slider.getElementsByClassName(this.itemClass),this.backButton=this.slider.getElementsByClassName(this.backButtonClass)[0],this.forwardButton=this.slider.getElementsByClassName(this.forwardButtonClass)[0],this.selectors=this.slider.getElementsByClassName(this.selectorClass)}},{key:"addEventListeners",value:function(){var t,e=this;this.backButton.addEventListener("click",(function(){return e.moveBack()})),this.forwardButton.addEventListener("click",(function(){return e.moveForvard()})),(t=this.selectors,function(t){if(Array.isArray(t))return s(t)}(t)||function(t){if("undefined"!=typeof Symbol&&null!=t[Symbol.iterator]||null!=t["@@iterator"])return Array.from(t)}(t)||n(t)||function(){throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.")}()).forEach((function(t,n){return t.addEventListener("click",(function(){return e.moveTo(n+1)}))})),this.container.addEventListener("pointerdown",(function(t){return e.handlePointerDown(t)})),this.container.addEventListener("pointerup",(function(t){return e.handlePointerUp(t)}))}},{key:"handlePointerDown",value:function(t){this.pointerDownX=t.x,this.pointerDownY=t.y}},{key:"handlePointerUp",value:function(t){var e=t.x-this.pointerDownX,n=t.y-this.pointerDownY;Math.abs(n)>Math.abs(e)||Math.abs(e)<10||(e>0?this.moveBack():this.moveForvard())}},{key:"handleNavigation",value:function(){this.handleBackButton(),this.handleForwardButton(),this.handleSelectors()}},{key:"handleBackButton",value:function(){1!==this.currentItem?this.backButton.classList.add(this.buttonActiveClass):this.backButton.classList.remove(this.buttonActiveClass)}},{key:"handleForwardButton",value:function(){this.currentItem!==this.lastItem?this.forwardButton.classList.add(this.buttonActiveClass):this.forwardButton.classList.remove(this.buttonActiveClass)}},{key:"handleSelectors",value:function(){var t,e=function(t,e){var s="undefined"!=typeof Symbol&&t[Symbol.iterator]||t["@@iterator"];if(!s){if(Array.isArray(t)||(s=n(t))){s&&(t=s);var i=0,r=function(){};return{s:r,n:function(){return i>=t.length?{done:!0}:{done:!1,value:t[i++]}},e:function(t){throw t},f:r}}throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.")}var a,o=!0,l=!1;return{s:function(){s=s.call(t)},n:function(){var t=s.next();return o=t.done,t},e:function(t){l=!0,a=t},f:function(){try{o||null==s.return||s.return()}finally{if(l)throw a}}}}(this.selectors);try{for(e.s();!(t=e.n()).done;)t.value.classList.remove(this.selectorActiveClass)}catch(t){e.e(t)}finally{e.f()}this.selectors[this.currentItem-1].classList.add(this.selectorActiveClass)}},{key:"moveBack",value:function(){1!==this.currentItem&&(this.currentItem--,this.move())}},{key:"moveForvard",value:function(){this.currentItem!==this.lastItem&&(this.currentItem++,this.move())}},{key:"moveTo",value:function(t){this.currentItem=t,this.move()}},{key:"move",value:function(){var t=-(this.currentItem-1)*this.itemWidth;this.container.style.transform="translateX(".concat(t,"px)"),this.handleNavigation()}},{key:"resize",value:function(t){this.itemWidth=t,this.move()}}])&&i(e.prototype,r),t}();window.addEventListener("load",(function(){new e("header__menu-button","header__menu").init(),new r("reviews","reviews__container","reviews__box","reviews__back","reviews__forward","reviews__selector","reviews__arrow--active","reviews__selector--active").init()}))}();