/* KTS · Compose your journey — formulaire simple (chips + texte -> email) */
(function(){
  var form=document.getElementById('jrnyForm');
  if(!form)return;
  var lang=(document.documentElement.lang||'en').toLowerCase().slice(0,2);
  var FR=lang==='fr';

  var TXTS={
    en:{sending:"Sending…",ok:"Thank you! Your request has been sent — our team will reply within one business day.",err:"Sorry, something went wrong. Please email us directly at incoming@ktsvoyages.fr.",none:"(none)"},
    fr:{sending:"Envoi en cours…",ok:"Merci ! Votre demande a bien été envoyée — notre équipe vous répond sous un jour ouvré.",err:"Désolé, une erreur est survenue. Écrivez-nous directement à incoming@ktsvoyages.fr.",none:"(aucune)"},
    es:{sending:"Enviando…",ok:"¡Gracias! Su solicitud ha sido enviada — nuestro equipo le responderá en un día laborable.",err:"Lo sentimos, se ha producido un error. Escríbanos directamente a incoming@ktsvoyages.fr.",none:"(ninguno)"},
    pt:{sending:"A enviar…",ok:"Obrigado! O seu pedido foi enviado — a nossa equipa responder-lhe-á no prazo de um dia útil.",err:"Lamentamos, ocorreu um erro. Contacte-nos diretamente através de incoming@ktsvoyages.fr.",none:"(nenhum)"}
  };
  var TXT=TXTS[lang]||TXTS.en;

  var THEMES=[
    {id:'gastronomy',en:'Gastronomy & wine',fr:'Gastronomie & vin'},
    {id:'nature',en:'Nature & outdoors',fr:'Nature & grands espaces'},
    {id:'culture',en:'Culture & heritage',fr:'Culture & patrimoine'},
    {id:'beach',en:'Beaches & sea',fr:'Plages & mer'},
    {id:'mountain',en:'Mountains & ski',fr:'Montagne & ski'},
    {id:'romance',en:'Romance',fr:'Romantique'},
    {id:'family',en:'Family',fr:'Famille'},
    {id:'art',en:'Art & gardens',fr:'Art & jardins'},
    {id:'history',en:'History',fr:'Histoire'},
    {id:'vip',en:'VIP & luxury',fr:'VIP & luxe'},
    {id:'wellness',en:'Wellness & spa',fr:'Bien-être & spa'},
    {id:'gastro2',en:'Fine dining',fr:'Tables étoilées'},
    {id:'sailing',en:'Sailing & boats',fr:'Voile & bateau'},
    {id:'golf',en:'Golf',fr:'Golf'},
    {id:'adventure',en:'Sport & adventure',fr:'Sport & aventure'},
    {id:'shopping',en:'Shopping & fashion',fr:'Shopping & mode'},
    {id:'nightlife',en:'Nightlife',fr:'Vie nocturne'},
    {id:'photo',en:'Photography',fr:'Photographie'},
    {id:'festivals',en:'Festivals & events',fr:'Festivals & événements'},
    {id:'local',en:'Local life & markets',fr:'Vie locale & marchés'}
  ];
  var DESTS=[
    {en:'Paris',fr:'Paris',img:'https://images.unsplash.com/photo-1526821799652-2dc51675628e?auto=format&fit=crop&w=400&q=70'},
    {en:'French Riviera',fr:"Côte d'Azur",img:'https://images.pexels.com/photos/13136997/pexels-photo-13136997.jpeg?auto=compress&cs=tinysrgb&w=400'},
    {en:'Provence',fr:'Provence',img:'https://images.unsplash.com/photo-1499002238440-d264edd596ec?auto=format&fit=crop&w=400&q=70'},
    {en:'Loire Valley',fr:'Val de Loire',img:'https://images.unsplash.com/photo-1650869653858-1c2c0768014f?auto=format&fit=crop&w=400&q=70'},
    {en:'Alsace',fr:'Alsace',img:'https://images.unsplash.com/photo-1588365399397-f09fd8745464?auto=format&fit=crop&w=400&q=70'},
    {en:'Bordeaux',fr:'Bordeaux',img:'https://images.unsplash.com/photo-1493564738392-d148cfbd6eda?auto=format&fit=crop&w=400&q=70'},
    {en:'Burgundy',fr:'Bourgogne',img:'https://images.pexels.com/photos/2954929/pexels-photo-2954929.jpeg?auto=compress&cs=tinysrgb&w=400'},
    {en:'French Alps',fr:'Alpes',img:'https://images.pexels.com/photos/34605838/pexels-photo-34605838.jpeg?auto=compress&cs=tinysrgb&w=400'},
    {en:'Corsica',fr:'Corse',img:'https://images.unsplash.com/photo-1545129228-7a804588bf8e?auto=format&fit=crop&w=400&q=70'},
    {en:'Normandy',fr:'Normandie',img:'https://images.pexels.com/photos/8430047/pexels-photo-8430047.jpeg?auto=compress&cs=tinysrgb&w=400'}
  ];

  var TYPES=[
    {en:'Tailor-made journey',fr:'Séjour sur mesure'},
    {en:'Group travel',fr:'Voyage de groupe'},
    {en:'MICE & conventions',fr:'MICE & conventions'},
    {en:'Incentive',fr:'Incentive'},
    {en:'VIP travel',fr:'Voyage VIP'}
  ];

  var selThemes={},selDests={},selTypes={};
  function buildChips(row,items,store){
    if(!row)return;
    items.forEach(function(it){
      var label=FR?it.fr:it.en;
      var b=document.createElement('button');b.type='button';b.className='chip';b.textContent=label;
      b.addEventListener('click',function(){store[label]=!store[label];b.classList.toggle('on',store[label]);});
      row.appendChild(b);
    });
  }
  var resetDest=function(){};
  function buildDestChips(){
    var row=document.getElementById('jrnyDests');
    if(!row)return;
    DESTS.forEach(function(it){
      var label=FR?it.fr:it.en;
      var b=document.createElement('button');b.type='button';b.className='dchip';
      b.innerHTML='<img src="'+it.img+'" loading="lazy" onerror="this.onerror=null;this.src=\'assets/hero1.jpg\'" alt=""><span>'+label+'</span>';
      b.addEventListener('click',function(){selDests[label]=!selDests[label];if(!selDests[label])delete selDests[label];b.classList.toggle('on',!!selDests[label]);});
      row.appendChild(b);
    });
    resetDest=function(){row.querySelectorAll('.dchip.on').forEach(function(c){c.classList.remove('on');});};
  }
  buildChips(document.getElementById('jrnyThemes'),THEMES,selThemes);
  buildDestChips();
  buildChips(document.getElementById('jrnyTypes'),TYPES,selTypes);

  function picked(store){return Object.keys(store).filter(function(k){return store[k];});}

  var statusEl=document.getElementById('jrnyStatus');
  var btn=form.querySelector('button[type="submit"]');var bl=btn?btn.textContent:'';
  form.addEventListener('submit',function(e){
    e.preventDefault();
    var honey=form.querySelector('[name="_honey"]');if(honey&&honey.value)return;
    var g=function(id){return (document.getElementById(id)||{}).value||'';};
    var who=(g('jf-first')+' '+g('jf-last')).trim();
    var dests=picked(selDests),themes=picked(selThemes);
    var data=new FormData();
    data.append('Name',who);
    data.append('email',g('jf-email'));
    data.append('Phone',g('jf-phone'));
    var types=picked(selTypes);
    data.append('Destinations',dests.length?dests.join(', '):TXT.none);
    data.append(FR?'Type de voyage':'Trip type',types.length?types.join(', '):TXT.none);
    data.append(FR?'Centres d\'intérêt':'Interests',themes.length?themes.join(', '):TXT.none);
    data.append('Dates',g('jf-dates'));
    data.append(FR?'Voyageurs':'Travellers',g('jf-people'));
    data.append('Message',g('jf-text'));
    data.append('Request type',FR?'Composez votre voyage':'Compose your journey');
    data.append('_subject',(FR?'Projet de voyage — ':'Journey request — ')+who);
    data.append('_template','table');data.append('_captcha','false');
    if(statusEl){statusEl.hidden=false;statusEl.className='cform-status';statusEl.textContent=TXT.sending;}
    if(btn){btn.disabled=true;btn.textContent=TXT.sending;}
    fetch('/api/contact.php',{method:'POST',body:data,headers:{'Accept':'application/json'}})
      .then(function(r){return r.json();})
      .then(function(res){
        if(res&&(res.success===true||res.success==='true')){
          if(statusEl){statusEl.className='cform-status ok';statusEl.textContent=TXT.ok;}
          form.reset();selThemes={};selDests={};selTypes={};
          form.querySelectorAll('.chip.on').forEach(function(c){c.classList.remove('on');});
          resetDest();
        }else{throw new Error('fail');}
      })
      .catch(function(){if(statusEl){statusEl.className='cform-status err';statusEl.textContent=TXT.err;}})
      .finally(function(){if(btn){btn.disabled=false;btn.textContent=bl;}});
  });
})();
