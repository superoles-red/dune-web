// Install instructions are independent of the renderer and native runtime.
const text={
 en:{
  heading:'INSTALL DUNE',button:'INSTALL GAME',
  apple:'In Safari, tap Share → Add to Home Screen. Enable Open as Web App if shown, then tap Add.',
  samsung:'In Samsung Internet, tap the install icon or choose Add to Home screen in the browser menu.',
  'android-chrome':'In Chrome, open the browser menu and choose Install app or Add to Home screen → Install.',
  android:'Use Install app in the browser menu. If needed, open this link in Chrome.',
  'mac-safari':'In Safari, choose File → Add to Dock.',
  desktop:'Use Install app in the browser menu or address bar. If it is unavailable, open this link in Chrome or Edge.',
  open:'Open Dune from its icon to play.',
 },
 ru:{
  heading:'УСТАНОВКА DUNE',button:'УСТАНОВИТЬ ИГРУ',
  apple:'В Safari нажмите «Поделиться» → «На экран Домой». Включите «Открыть как веб-приложение», если есть такой пункт, и нажмите «Добавить».',
  samsung:'В Samsung Internet нажмите значок установки или выберите «Добавить на главный экран» в меню браузера.',
  'android-chrome':'В меню Chrome выберите «Установить приложение» или «Добавить на главный экран» → «Установить».',
  android:'Выберите «Установить приложение» в меню браузера. Если нужно, откройте ссылку в Chrome.',
  'mac-safari':'В Safari выберите «Файл» → «Добавить в Dock».',
  desktop:'Выберите «Установить приложение» в меню браузера или адресной строке. Если пункта нет, откройте ссылку в Chrome или Edge.',
  open:'Чтобы играть, откройте Dune со значка.',
 },
};

export function localDiagnostics(url){
 const localhost=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 return Object.fromEntries(['qa','legacy','inputcheck'].map(key=>[key,localhost&&url.searchParams.has(key)]));
}

export function installLanguage(nav=globalThis.navigator,storage){
 try{
  const saved=storage?.getItem('dune-sega-language-v1');
  if(saved==='en'||saved==='ru')return saved;
 }catch{}
 return /^ru(?:-|$)/i.test(nav?.language||'')?'ru':'en';
}

export function mountInstallGate({platform,gate,language}){
 const words=text[language]||text.en;
 const heading=gate.querySelector('h1'),hint=gate.querySelector('#install-hint');
 const button=gate.querySelector('#install-application');
 let requested=false,busy=false;
 heading.textContent=words.heading;button.textContent=words.button;
 gate.querySelector('#install-open').textContent=words.open;gate.lang=language;gate.hidden=false;
 const render=({installed,canInstall,installationKind})=>{
  const done=installed||requested;
  hint.hidden=done;hint.textContent=words[installationKind]||words.desktop;
  button.hidden=done||!canInstall;button.disabled=busy;
 };
 platform.subscribe(render);render(platform.snapshot());
 button.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;
  try{
   // prompt() must start in this click, before any download or asynchronous work.
   const request=platform.install();render(platform.snapshot());
   requested=(await request)==='accepted';
  }catch{/* Keep the platform-specific instructions available. */}
  finally{busy=false;render(platform.snapshot());}
 });
}
