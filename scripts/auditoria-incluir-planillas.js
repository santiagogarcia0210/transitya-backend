#!/usr/bin/env node
// AUDITORÍA DE SOLO LECTURA: ¿están todos los pacientes de Incluir Salud en Planilla Incluir y en DJ ESC 107?
//
//   node scripts/auditoria-incluir-planillas.js --listar-empresas       IDs de las empresas (para elegir --tenant)
//   node scripts/auditoria-incluir-planillas.js --tenant=<id>           Auditoría de una empresa
//
// NO escribe nada. Imprime SOLO conteos e IDs de documento: nunca nombres, DNI, teléfonos ni domicilios.
// (Los valores de "obra social" sí se muestran, agrupados, porque no identifican a nadie.)
//
// Qué simula: lo que HOY ve cada pantalla del frontend.
//   · Planilla Incluir: el front descarta todas las filas de /api/planillas/incluir (busca `nroAfiliado` y el
//     endpoint devuelve `afiliado`), así que siempre cae a /api/beneficiarios (registro + BENEFICIARIOS) y
//     deja solo a quien tiene N° AFILIADO (clave 'N° AFILIADO' o `nroAfiliado`).
//   · DJ ESC 107: usa /api/planillas/dj107 (solo `registro`, solo con nombre) y deja solo a quien tiene
//     'N° AFILIADO'. Únicamente si NO queda nadie cae al listado de /api/beneficiarios.
// Ninguna de las dos filtra por obra social.
//
// OJO: usa FIREBASE_SA de tu .env (en esta máquina, producción).
require('dotenv').config();
const admin = require('firebase-admin');

const arg = n => { const a = process.argv.find(x => x === `--${n}` || x.startsWith(`--${n}=`)); return a ? (a.includes('=') ? a.split('=').slice(1).join('=') : true) : null; };

const sinAcentos = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const lleno = v => v !== undefined && v !== null && String(v).trim() !== '';
const primero = (d, claves) => { for (const k of claves) if (lleno(d[k])) return { clave: k, valor: String(d[k]).trim() }; return { clave: null, valor: '' }; };

const K_NOMBRE = ['APELLIDO Y NOMBRE', 'NOMBRE'];
const K_NOMBRE_ALT = ['nombre', 'apellido', 'apellidoNombre'];
const K_OS = ['OBRA SOCIAL', 'OS', 'obraSocial', 'OBRASOCIAL', 'obra_social'];
const K_AFIL = ['N° AFILIADO', 'nroAfiliado', 'NRO_AFILIADO', 'nro_afiliado', 'AFILIADO', 'afiliado', 'N AFILIADO', 'NRO AFILIADO'];
const esIncluir = os => /\bINCLUIR\b/.test(sinAcentos(os));

(async () => {
  let sa;
  try { sa = JSON.parse(process.env.FIREBASE_SA); } catch { console.error('Falta FIREBASE_SA en el .env.'); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'gestion-transporte-ef756' });
  const db = admin.firestore();

  if (arg('listar-empresas')) {
    const refs = await db.collection('empresas').listDocuments();
    console.log(`Empresas (${refs.length}):`); refs.forEach(r => console.log('  ' + r.id));
    return;
  }
  const tenant = arg('tenant');
  if (!tenant || tenant === true) { console.error('Uso: --tenant=<id>  (o --listar-empresas)'); process.exit(1); }

  const base = db.collection('empresas').doc(tenant);
  const subs = (await base.listCollections()).map(c => c.id);
  console.log(`Empresa ${tenant}. Colecciones: ${subs.join(', ')}`);

  const leer = async n => subs.includes(n) ? (await base.collection(n).get()).docs : [];
  const [reg, ben] = await Promise.all([leer('registro'), leer('BENEFICIARIOS')]);
  // Otras colecciones que podrían tener pacientes (solo se cuentan; no se cruzan).
  const otras = subs.filter(n => /benef|pacient|afiliad|registro/i.test(n) && !['registro', 'BENEFICIARIOS'].includes(n));
  for (const n of otras) console.log(`  (posible colección de pacientes sin auditar: ${n}, ${(await base.collection(n).get()).size} docs)`);

  const idsReg = new Set(reg.map(d => d.id));
  const pacientes = [
    ...reg.map(d => ({ id: d.id, col: 'registro', d: d.data() })),
    ...ben.filter(d => !idsReg.has(d.id)).map(d => ({ id: d.id, col: 'BENEFICIARIOS', d: d.data() })),
  ];
  const duplicados = ben.filter(d => idsReg.has(d.id)).map(d => d.id);

  const osCuenta = {};
  const ficha = pacientes.map(({ id, col, d }) => {
    const os = primero(d, K_OS), af = primero(d, K_AFIL), nom = primero(d, K_NOMBRE);
    const nombreAlt = !nom.clave && K_NOMBRE_ALT.some(k => lleno(d[k]));
    osCuenta[os.valor || '(vacía)'] = (osCuenta[os.valor || '(vacía)'] || 0) + 1;
    const afMayus = lleno(d['N° AFILIADO']);
    return {
      id, col, incluir: esIncluir(os.valor), osClave: os.clave, osRaw: os.valor,
      conNombre: !!nom.clave, nombreSoloAlt: nombreAlt,
      afiliadoCanon: afMayus, afiliadoAlgunaClave: !!af.clave, afiliadoClave: af.clave,
      inactivo: d.activo === false,
    };
  });

  // Lo que ve hoy cada pantalla (ver cabecera).
  const regConNombre = ficha.filter(f => f.col === 'registro' && f.conNombre);
  const dj107UsaEndpoint = regConNombre.some(f => f.afiliadoCanon);
  const enIncluir = f => f.afiliadoAlgunaClave;                 // fallback: nroAfiliado || 'N° AFILIADO' (aprox. por cualquier clave de afiliado)
  const enIncluirEstricto = f => lleno(pacientes.find(p => p.id === f.id).d['N° AFILIADO']) || lleno(pacientes.find(p => p.id === f.id).d.nroAfiliado);
  const enDj = f => dj107UsaEndpoint ? (f.col === 'registro' && f.conNombre && f.afiliadoCanon) : enIncluirEstricto(f);

  const inc = ficha.filter(f => f.incluir);
  const motivos = {};
  const agrega = (m, id) => (motivos[m] = motivos[m] || []).push(id);
  for (const f of inc) {
    const enI = enIncluirEstricto(f), enD = enDj(f);
    if (enI && enD) continue;
    if (!enI) {
      if (!f.afiliadoAlgunaClave) agrega('Planilla Incluir: sin N° de afiliado en ninguna clave', f.id);
      else agrega('Planilla Incluir: N° de afiliado solo en una clave que el front no lee (' + f.afiliadoClave + ')', f.id);
    }
    if (!enD) {
      if (f.col === 'BENEFICIARIOS') agrega('DJ ESC 107: vive en BENEFICIARIOS (el endpoint solo lee registro)', f.id);
      else if (!f.conNombre) agrega(f.nombreSoloAlt ? 'DJ ESC 107: sin "APELLIDO Y NOMBRE"/"NOMBRE" (solo claves camelCase)' : 'DJ ESC 107: sin nombre', f.id);
      else if (!f.afiliadoCanon) agrega('DJ ESC 107: falta "N° AFILIADO"' + (f.afiliadoAlgunaClave ? ` (el N° está en ${f.afiliadoClave})` : ''), f.id);
    }
    if (f.col === 'BENEFICIARIOS') agrega('Edición: vive en BENEFICIARIOS → PUT/GET/gps/baja devuelven 404 (no deja guardar)', f.id);
    if (f.inactivo) agrega('Marcado activo:false', f.id);
  }
  const otrasOS = ficha.filter(f => !f.incluir);
  const otrasEnPlanilla = otrasOS.filter(f => enIncluirEstricto(f));
  // Grafías distintas de Incluir (para unificarlas) y OS vacía.
  const grafiasIncluir = {};
  inc.forEach(f => { grafiasIncluir[f.osRaw] = (grafiasIncluir[f.osRaw] || 0) + 1; });
  const sinOS = ficha.filter(f => !f.osRaw).map(f => f.id);

  console.log('\n══════════ RESUMEN ══════════');
  console.log(`Pacientes: ${ficha.length}  (registro: ${reg.length}; solo en BENEFICIARIOS: ${ficha.filter(f => f.col === 'BENEFICIARIOS').length}; ids repetidos en ambas: ${duplicados.length})`);
  console.log(`De Incluir (cualquier grafía): ${inc.length}`);
  console.log(`  aparecen HOY en Planilla Incluir: ${inc.filter(enIncluirEstricto).length}   | faltan: ${inc.filter(f => !enIncluirEstricto(f)).length}`);
  console.log(`  aparecen HOY en DJ ESC 107:       ${inc.filter(enDj).length}   | faltan: ${inc.filter(f => !enDj(f)).length}   (la pantalla usa ${dj107UsaEndpoint ? 'el endpoint /dj107' : 'el listado general'})`);
  console.log(`  viven en BENEFICIARIOS (no se pueden editar): ${inc.filter(f => f.col === 'BENEFICIARIOS').length}`);
  console.log(`De OTRAS obras sociales que HOY salen en Planilla Incluir (no deberían): ${otrasEnPlanilla.length}`);
  console.log(`Sin obra social cargada: ${sinOS.length}`);
  console.log('\nGrafías de Incluir encontradas (conteo):'); Object.entries(grafiasIncluir).forEach(([k, v]) => console.log(`  "${k}": ${v}`));
  console.log('\nValores de obra social en toda la empresa (conteo):'); Object.entries(osCuenta).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  "${k}": ${v}`));
  console.log('\n══════════ MOTIVOS (IDs de documento) ══════════');
  if (!Object.keys(motivos).length) console.log('  Ningún paciente de Incluir queda afuera.');
  for (const [m, ids] of Object.entries(motivos)) console.log(`- ${m}: ${ids.length}\n    ${ids.join(', ')}`);
  if (sinOS.length) console.log(`- Sin obra social: ${sinOS.length}\n    ${sinOS.join(', ')}`);
  console.log('\n(Solo lectura: no se modificó nada.)');
})().catch(e => { console.error('Error:', e.code || e.name); process.exit(1); });
