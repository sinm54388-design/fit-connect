(() => {
  const catalog = {
    deadlift: {label:'컨벤셔널 데드리프트',aliases:['데드리프트','컨벤셔널 데드리프트','conventional deadlift','barbell deadlift','deadlift']},
    pulldown: {label:'오버그립 랫풀다운',aliases:['랫풀다운','렛풀다운','랫풀 다운','랫풀','오버그립 랫풀다운','lat pulldown']},
    row: {label:'케이블 시티드 로우',aliases:['케이블 시티드 로우','시티드 로우','케이블 시티드로우','시티드 케이블 로우','seated cable row','cable row']},
    bench: {label:'바벨 벤치프레스',aliases:['벤치프레스','바벨 벤치프레스','플랫 벤치프레스','bench press','barbell bench press']},
    pushup: {label:'기본 푸쉬업',aliases:['푸쉬업','푸시업','팔굽혀펴기','기본 푸쉬업','push-up','pushup']}
  };
  const normalize = value => String(value||'').normalize('NFKC').toLowerCase().replace(/[\s_-]+/g,'');
  const aliases = new Map(Object.entries(catalog).flatMap(([key,item])=>item.aliases.map(name=>[normalize(name),key])));
  function exerciseModel({name,demoKey}) {
    if (demoKey==='none') return '';
    if (Object.hasOwn(catalog,demoKey)) return demoKey;
    return aliases.get(normalize(name))||'';
  }
  const mix = (a,b,t) => a.map((value,i)=>value+(b[i]-value)*t);
  const add = (a,b) => a.map((value,i)=>value+b[i]);
  const subtract = (a,b) => a.map((value,i)=>value-b[i]);
  const times = (a,n) => a.map(value=>value*n);
  const dot = (a,b) => a.reduce((value,n,i)=>value+n*b[i],0);
  const norm = a => Math.hypot(...a);
  const unit = a => times(a,1/(norm(a)||1));
  function elbow(shoulder,hand,bend) {
    const axis=unit(subtract(hand,shoulder)), length=norm(subtract(hand,shoulder));
    const direction=unit(subtract(bend,times(axis,dot(bend,axis))));
    const along=(length**2+.31**2-.30**2)/(2*Math.max(.01,length));
    const radius=Math.sqrt(Math.max(0,.31**2-along**2));
    return add(add(shoulder,times(axis,Math.min(along,length))),times(direction,radius));
  }
  const point = (y,z) => [0,y,z];
  function figure(key,t) {
    let hip, chest, knee, foot, hand, bend, equipment=[];
    const bar=(a,b)=>equipment.push({a,b,width:.028,color:'#657c98'});
    const pad=(a,b,width=.16)=>equipment.push({a,b,width,color:'#9fb2c8'});
    const frame=(a,b)=>equipment.push({a,b,width:.036,color:'#a9bdd3'});
    const plates=(y,z,width)=>{
      bar([-width-.15,y,z],[width+.15,y,z]);
      for (const side of [-1,1]) equipment.push({a:[side*width,y,z],b:[side*(width+.075),y,z],width:.42,color:'#536f8f',disk:true});
    };
    if (key==='deadlift') {
      const lift = Math.min(1,t*2);
      hip=t<.5?mix(point(.72,-.43),point(.79,-.37),lift):mix(point(.79,-.37),point(1.05,-.075),(t-.5)*2);
      chest=t<.5?mix(point(.83,.07),point(1.13,.02),lift):mix(point(1.13,.02),point(1.59,-.075),(t-.5)*2);
      knee=mix(point(.49,.095),point(.52,-.075),t);
      foot=point(.085,-.04);
      hand=[.315,t<.5?.235+.31*lift:.545+.46*(t-.5)*2,.17-.08*t];
      plates(hand[1],hand[2],.66);
    } else if (key==='pulldown') {
      hip=point(.58,-.07);
      chest=point(1.12,-.07-.10*t);
      knee=point(.58,.37);
      foot=point(.08,.26);
      hand=[.405,1.65-.57*t,.12+.10*t];
      bend=[.85,-.65,-.15];
      pad(point(.50,-.29),point(.50,.18));
      pad([-.27,.67,.29],[.27,.67,.29],.10);
      frame(point(.08,-.18),point(.49,-.18));
      frame(point(0,.68),point(1.94,.68));
      frame(point(1.94,.68),point(1.94,.15));
      bar([-.53,hand[1],hand[2]],[.53,hand[1],hand[2]]);
      bar(point(1.94,.15),point(hand[1],hand[2]));
    } else if (key==='row') {
      hip=point(.41,-.24);
      chest=point(.94,-.17-.09*t);
      knee=point(.50,.29);
      foot=point(.26,.71);
      hand=[.125,.75-.12*t,.39-.53*t];
      bend=[.45,-.2,-1];
      pad(point(.32,-.42),point(.32,.09));
      frame(point(.03,-.38),point(.03,.98));
      frame(point(.03,-.24),point(.29,-.24));
      frame(point(0,1.01),point(1.16,1.01));
      pad([-.32,.23,.77],[.32,.23,.77],.09);
      bar([-.15,hand[1],hand[2]],[.15,hand[1],hand[2]]);
      bar(point(.50,.99),point(hand[1],hand[2]));
    } else if (key==='bench') {
      hip=point(.52,.35);
      chest=point(.57,-.23);
      knee=[.24,.49,.67];
      foot=[.29,.08,.54];
      hand=[.37,.73+.43*t,-.06-.16*t];
      bend=[.7,-1,.2];
      pad(point(.41,-.65),point(.41,.45),.15);
      for (const z of [-.48,.35]) frame(point(.03,z),point(.36,z));
      plates(hand[1],hand[2],.64);
    } else {
      chest=point(.25+.34*t,.43-.14*t);
      foot=point(.065,-.94);
      hip=mix(foot,chest,.54);
      knee=mix(foot,chest,.27);
      hand=[.28,.055,.42];
      bend=[.44,.1,-1];
    }
    const spine=unit(subtract(chest,hip));
    const head=key==='bench'?add(chest,point(-.013,-.245)):add(chest,times(spine,.225));
    const segments=[];
    const limb=(a,b,width,color)=>segments.push({a,b,width,color});
    limb(hip,mix(hip,chest,.72),.32,'#2659ac');
    limb(mix(hip,chest,.6),chest,.35,'#3579d2');
    limb(chest,mix(chest,head,.60),.105,'#a6c9ef');
    for (const side of [-1,1]) {
      const mirror = (p,dx) => [side*(p[0]||dx),p[1],p[2]];
      const shoulder=mirror(chest,.206), hipSide=mirror(hip,.116);
      const handSide=mirror(hand,.28), kneeSide=mirror(knee,.145), footSide=mirror(foot,.155);
      const bendSide=bend?[side*bend[0],bend[1],bend[2]]:[side*.03,0,-1];
      const arm=key==='deadlift'?mix(shoulder,handSide,.51):elbow(shoulder,handSide,bendSide);
      limb(chest,shoulder,.128,'#417fd2');
      limb(hip,hipSide,.169,'#275398');
      limb(hipSide,kneeSide,.145,'#315b9b');
      limb(kneeSide,footSide,.097,'#467bbd');
      limb(footSide,add(footSide,point(-.033,key==='pushup'?.075:.18)),.085,'#263e62');
      limb(shoulder,arm,.101,'#78a9df');
      limb(arm,handSide,.078,'#a1c4e9');
      limb(handSide,add(handSide,point(-.028,.045)),.07,'#bad5f1');
    }
    return {segments:[...equipment,...segments],head};
  }

  function draw(canvas,key,t,view) {
    const ctx=canvas.getContext('2d');
    if (!ctx) return;
    const {width:w,height:h}=canvas;
    const landscape=['row','bench','pushup'].includes(key);
    const scale=Math.min(h/(landscape?1.68:2.25),w/(landscape?2.55:2.15));
    const angle=view==='front'?-.12:Math.PI/2-.14;
    const cosine=Math.cos(angle), sine=Math.sin(angle);
    const project=([x,y,z])=>{
      const horizontal=x*cosine-z*sine, depth=x*sine+z*cosine;
      return [w/2+horizontal*scale,h*(landscape?.76:.9)-(y-depth*.12)*scale,depth];
    };
    const background=ctx.createLinearGradient(0,0,0,h);
    background.addColorStop(0,'#f4f8ff');
    background.addColorStop(1,'#dce8f9');
    ctx.fillStyle=background;
    ctx.fillRect(0,0,w,h);
    ctx.lineWidth=Math.max(1,w/550);
    ctx.strokeStyle='#b9cce6';
    for(let i=-4;i<=4;i++){
      const plot=(a,b)=>{
        const p=project(a),q=project(b);
        ctx.beginPath();ctx.moveTo(p[0],p[1]);ctx.lineTo(q[0],q[1]);ctx.stroke();
      };
      plot([i*.28,0,-1.4],[i*.28,0,1.4]);
      plot([-1.2,0,i*.31],[1.2,0,i*.31]);
    }
    const {segments,head}=figure(key,t);
    const parts=segments.map(segment=>({...segment,p:project(segment.a),q:project(segment.b)}));
    const hc=project(head);
    parts.push({p:hc,q:hc,width:.197,color:'#a6c9ef'});
    parts.sort((a,b)=>(a.p[2]+a.q[2])-(b.p[2]+b.q[2]));
    for (const {p,q,width,color,disk} of parts) {
      const span=width*scale;
      if (disk) {
        ctx.fillStyle=color;
        ctx.beginPath();
        ctx.ellipse((p[0]+q[0])/2,(p[1]+q[1])/2,span*(.09+.40*Math.abs(sine)),span*.5,0,0,Math.PI*2);
        ctx.fill();
        continue;
      }
      ctx.lineCap='round';
      ctx.lineWidth=span;
      ctx.strokeStyle=color;
      ctx.beginPath();
      ctx.moveTo(p[0],p[1]);ctx.lineTo(q[0]+.01,q[1]);ctx.stroke();
      ctx.lineWidth=span*.25;
      ctx.strokeStyle='#ffffff42';
      ctx.beginPath();
      ctx.moveTo(p[0]-span*.22,p[1]-span*.14);ctx.lineTo(q[0]-span*.22+.01,q[1]-span*.14);ctx.stroke();
    }
  }

  const thumbnails = new Map();
  let activeDialog;
  function showModel(key,note) {
    activeDialog?.close();
    const dialog=document.createElement('dialog');
    dialog.className='fit-motion-dialog';
    dialog.setAttribute('aria-label',catalog[key].label+' 동작 보기');
    const title=document.createElement('h2');
    title.textContent=catalog[key].label;
    const close=document.createElement('button');
    close.type='button';close.textContent='닫기';close.onclick=()=>dialog.close();
    const header=document.createElement('header');
    header.append(title,close);
    const canvas=document.createElement('canvas');
    canvas.width=720;canvas.height=470;
    canvas.setAttribute('aria-label',catalog[key].label+' 사람 모형 애니메이션');
    const controls=document.createElement('div');
    controls.className='fit-motion-controls';
    let view='side',speed=1,playing=!matchMedia('(prefers-reduced-motion: reduce)').matches,phase=0,frame=0,last=0;
    const control=(label,action)=>{
      const button=document.createElement('button');
      button.type='button';button.textContent=label;button.onclick=action;
      controls.append(button);
      return button;
    };
    const setView=next=>{
      view=next;
      front.setAttribute('aria-pressed',String(view==='front'));
      side.setAttribute('aria-pressed',String(view==='side'));
      render();
    };
    const front=control('정면',()=>setView('front'));
    const side=control('측면',()=>setView('side'));
    const slow=control('0.5배 느리게',()=>{
      speed=speed===1?.5:1;
      slow.setAttribute('aria-pressed',String(speed!==1));
    });
    slow.setAttribute('aria-pressed','false');
    const play=control(playing?'일시정지':'재생',()=>{
      playing=!playing;
      play.textContent=playing?'일시정지':'재생';
      if (playing) { last=0;frame=requestAnimationFrame(tick); }
      else cancelAnimationFrame(frame);
    });
    const render=()=>draw(canvas,key,(1-Math.cos(phase))/2,view);
    function tick(time) {
      if (!dialog.open||!playing) return;
      if(last)phase=(phase+Math.min(time-last,50)*speed*Math.PI/1600)%(Math.PI*2);
      last=time;
      render();
      frame=requestAnimationFrame(tick);
    }
    dialog.append(header,canvas,controls);
    if (note) {
      const cue=document.createElement('p');
      cue.className='fit-motion-note';
      cue.textContent='코치 포인트 · '+note;
      dialog.append(cue);
    }
    document.body.append(dialog);
    activeDialog=dialog;
    dialog.addEventListener('close',()=>{cancelAnimationFrame(frame);dialog.remove();if(activeDialog===dialog)activeDialog=null;},{once:true});
    dialog.showModal();
    setView('side');
    if (playing) frame=requestAnimationFrame(tick);
  }

  function mount(root,routines) {
    root.querySelectorAll('[data-motion-slot]').forEach(slot=>{
      const exercise=routines[Number(slot.dataset.motionSlot)];
      if (!exercise) return;
      const key=exerciseModel(exercise);
      if (!key) return;
      if (!thumbnails.has(key)) {
        const thumbnail=document.createElement('canvas');
        thumbnail.width=144;thumbnail.height=108;
        draw(thumbnail,key,.53,'side');
        thumbnails.set(key,thumbnail.toDataURL());
      }
      const button=document.createElement('button');
      button.className='fit-motion-preview';
      button.type='button';
      const image=document.createElement('img');
      image.src=thumbnails.get(key);
      image.alt='';
      image.width=64;image.height=48;
      const label=document.createElement('span');
      label.textContent='동작 보기';
      button.append(image,label);
      button.setAttribute('aria-label',catalog[key].label+' 동작 보기');
      button.onclick=()=>showModel(key,exercise.note);
      slot.replaceChildren(button);
    });
  }
  function setup() {
    const select=document.getElementById('fitMotionPick');
    for (const [value,item] of Object.entries(catalog)) select.add(new Option(item.label,value));
    const name=document.getElementById('exName');
    const automatic=select.options[0];
    const sync=()=>{
      const key=exerciseModel({name:name.value});
      automatic.textContent=key?'자동 · '+catalog[key].label:'운동 이름으로 자동 연결';
    };
    name.addEventListener('input',sync);
    select.parentElement.querySelector('button').onclick=()=>{
      const key=exerciseModel({name:name.value,demoKey:select.value});
      if (key) showModel(key,document.getElementById('exNote').value);
      else showToast('목록에서 동작 모형을 먼저 선택해 주세요.');
    };
    sync();
  }
  function selectModel(value) {
    const select=document.getElementById('fitMotionPick');
    if (!select) return;
    select.value=value==='none'||Object.hasOwn(catalog,value)?value:'';
    document.getElementById('exName').dispatchEvent(new Event('input'));
  }
  window.fitMotion={mount,selectModel,close:()=>activeDialog?.close()};
  document.addEventListener('DOMContentLoaded',setup);
})();
