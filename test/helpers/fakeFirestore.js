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

  const coleccion = (base) => ({
    doc: (id) => ref(base + '/' + id),
    async get() {
      return {
        docs: [...docs.keys()]
          .filter(k => k.startsWith(base + '/') && !k.slice(base.length + 1).includes('/'))
          .map(k => ({ id: k.slice(base.length + 1), data: () => structuredClone(docs.get(k)), ref: ref(k) })),
      };
    },
  });

  return {
    docs,
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
