// Firestore en memoria, lo justo para los módulos de correo: documentos por ruta,
// colecciones con get() y un runTransaction mínimo. Sin red, sin credenciales.

function fakeDb() {
  const docs = new Map();

  const ref = (ruta) => ({
    ruta,
    async get() {
      const d = docs.get(ruta);
      return { exists: d !== undefined, data: () => (d === undefined ? undefined : structuredClone(d)), ref: ref(ruta) };
    },
    async set(v) { docs.set(ruta, structuredClone(v)); },
    async update(v) {
      if (!docs.has(ruta)) throw new Error('NOT_FOUND: ' + ruta);   // igual que Firestore real
      docs.set(ruta, { ...docs.get(ruta), ...structuredClone(v) });
    },
    async delete() { docs.delete(ruta); },
    collection: (sub) => coleccion(ruta + '/' + sub),
  });

  // Firestore real admite hasta 30 valores en un "in" (antes 10) y rechaza listas vacías. Se impone
  // el límite más estricto que se conoce, para que las pruebas fallen si un servicio lo viola.
  const LIMITE_IN = 30;
  const coincide = (valor, op, esperado) => {
    if (op === '==') return valor === esperado;
    if (op === '!=') return valor !== esperado;
    if (op === 'in') return esperado.includes(valor);
    throw new Error('operador no soportado por el fake: ' + op);
  };
  const consulta = (base, filtros = [], tope = null) => ({
    where(campo, op, valor) {
      if (op === 'in') {
        if (!Array.isArray(valor) || valor.length === 0) throw new Error('INVALID_ARGUMENT: "in" necesita al menos un valor');
        if (valor.length > LIMITE_IN) throw new Error('INVALID_ARGUMENT: "in" admite como máximo ' + LIMITE_IN + ' valores');
      }
      return consulta(base, [...filtros, [campo, op, valor]], tope);
    },
    limit(n) { return consulta(base, filtros, n); },
    async get() {
      let lista = [...docs.keys()]
        .filter(k => k.startsWith(base + '/') && !k.slice(base.length + 1).includes('/'))
        .map(k => ({ id: k.slice(base.length + 1), data: () => structuredClone(docs.get(k)), ref: ref(k) }))
        .filter(d => filtros.every(([campo, op, valor]) => coincide(d.data()[campo], op, valor)));
      if (tope !== null) lista = lista.slice(0, tope);
      return { docs: lista, size: lista.length, empty: lista.length === 0, forEach: fn => lista.forEach(fn) };
    },
  });
  /** Cuántas consultas se hicieron a cada colección: sirve para probar que no se trae de más. */
  const lecturas = [];
  const coleccion = (base) => ({
    doc: (id) => ref(base + '/' + id),
    where(campo, op, valor) { lecturas.push({ base, tipo: 'where', campo, op, cantidad: Array.isArray(valor) ? valor.length : 1 }); return consulta(base).where(campo, op, valor); },
    limit(n) { return consulta(base).limit(n); },
    async get() { lecturas.push({ base, tipo: 'get' }); return consulta(base).get(); },
  });

  return {
    docs,
    lecturas,
    coleccion,
    ref,
    collection: (nombre) => coleccion(nombre),
    /** Tamaño de cada batch confirmado, para comprobar que se respeta el límite. */
    commits: [],
    batch() {
      const ops = [];
      const self = this;
      return {
        update(r, v) { ops.push(['update', r, v]); },
        set(r, v) { ops.push(['set', r, v]); },
        async commit() {
          if (ops.length > 500) throw new Error('INVALID_ARGUMENT: un batch admite como máximo 500 operaciones');
          for (const [tipo, r, v] of ops) await (tipo === 'update' ? r.update(v) : r.set(v));
          self.commits.push(ops.length);
        },
      };
    },
    async runTransaction(fn) {
      return fn({
        async get(r) { return r.get(); },
        update(r, v) { docs.set(r.ruta, { ...(docs.get(r.ruta) || {}), ...v }); },
        set(r, v) { docs.set(r.ruta, { ...v }); },
      });
    },
    /** Mails guardados de una empresa, ordenados por UID, para las aserciones. */
    mails(tenantId) {
      const base = 'empresas/' + tenantId + '/correo_mails/';
      return [...docs.entries()].filter(([k]) => k.startsWith(base)).map(([, v]) => v);
    },
  };
}

/** utils falso: solo lo que usan correoSync y correoClasificador. */
function fakeUtils(db) {
  return {
    col: (t, sub) => db.coleccion('empresas/' + t + '/' + sub),
    normalizarText_: s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(),
  };
}

module.exports = { fakeDb, fakeUtils };
