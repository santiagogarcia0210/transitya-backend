// Servidor IMAP de prueba, en memoria. Imita la API de imapflow que usa correoSync
// (connect, list, mailboxOpen, search, fetch, logout) y reproduce los comportamientos
// del protocolo que importan para las carpetas:
//   - cada carpeta tiene SUS PROPIOS UIDs (dos carpetas pueden tener el UID 1) y su
//     propio uidValidity;
//   - el rango "N:*" devuelve siempre el último mensaje, aunque sea anterior a N;
//   - las carpetas contenedoras (\Noselect, como "[Gmail]") no se pueden abrir.
//
// El cliente va envuelto en un Proxy: cualquier método fuera de los de lectura (store,
// delete, move, expunge, append, flags...) se registra en registro.prohibidas y lanza,
// así las pruebas pueden afirmar que el módulo es de SOLO LECTURA.
//
// No es un servidor IMAP por red: es el cliente de imapflow reemplazado por una versión
// en memoria con la misma interfaz, que es lo que correoSync recibe por inyección.

class ServidorImapFalso {
  constructor({ pass = 'clave', accessToken = 'token-ok' } = {}) {
    this.pass = pass;
    this.accessToken = accessToken;
    this.carpetas = new Map();
    this.registro = { conexiones: 0, aperturas: [], busquedas: [], fetches: [], logouts: 0, prohibidas: [] };
  }

  crearCarpeta(path, { uidValidity = 1000, especial = '', noselect = false } = {}) {
    this.carpetas.set(path, { uidValidity, siguienteUid: 1, mensajes: [], especial, noselect });
    return this;
  }

  /** Agrega un mail y devuelve el UID que le tocó (incremental, propio de la carpeta). */
  agregarMail(path, { messageId, de = 'ospe@osprera.org.ar', asunto = 'Aviso', texto = 'cuerpo', diasAtras = 1 } = {}) {
    const c = this.carpetas.get(path);
    if (!c) throw new Error('carpeta inexistente: ' + path);
    const uid = c.siguienteUid++;
    const fecha = new Date(Date.now() - diasAtras * 86400000);
    c.mensajes.push({ uid, messageId, de, asunto, texto, fecha });
    return uid;
  }

  /** n mails de relleno, con Message-ID propio, para probar el tope. */
  agregarMuchos(path, n, prefijo) {
    for (let i = 1; i <= n; i++) this.agregarMail(path, { messageId: `<${prefijo}-${i}@x>`, asunto: `${prefijo} ${i}` });
  }

  /** Lo que hace una regla de Outlook: el mail sale de una carpeta y entra en otra con UID nuevo. */
  moverMail(desde, hacia, uid) {
    const o = this.carpetas.get(desde);
    const m = o.mensajes.find(x => x.uid === uid);
    o.mensajes = o.mensajes.filter(x => x.uid !== uid);
    return this.agregarMail(hacia, { messageId: m.messageId, de: m.de, asunto: m.asunto, texto: m.texto });
  }

  /** El servidor reinicia los UIDs de una carpeta: cambia el uidValidity y renumera. */
  reiniciarUids(path, nuevoUidValidity) {
    const c = this.carpetas.get(path);
    c.uidValidity = nuevoUidValidity;
    c.mensajes.forEach((m, i) => { m.uid = i + 1; });
    c.siguienteUid = c.mensajes.length + 1;
  }

  /** Lo que correoSync recibe como `factory`. */
  factory() {
    return (cfg) => {
      const cliente = new ClienteFalso(this, cfg);
      return new Proxy(cliente, {
        get(t, p, receptor) {
          if (p in t) return Reflect.get(t, p, receptor);
          if (typeof p === 'symbol' || p === 'then') return undefined;
          return () => {
            t.servidor.registro.prohibidas.push(String(p));
            throw new Error('Operación no permitida (solo lectura): ' + String(p));
          };
        },
      });
    };
  }

  /** parse de mailparser, simplificado: devuelve la forma que lee normalizarMensaje. */
  parseFalso() {
    return async (source) => {
      const m = JSON.parse(source.toString('utf8'));
      return {
        messageId: m.messageId,
        from: { value: [{ address: m.de, name: '' }] },
        to: { value: [{ address: 'trabajo@empresa.com' }] },
        subject: m.asunto,
        date: new Date(m.fecha),
        text: m.texto,
        attachments: [],
        headers: new Map(),
      };
    };
  }
}

class ClienteFalso {
  constructor(servidor, cfg) {
    this.servidor = servidor;
    this.cfg = cfg;
    this.actual = null;
  }

  async connect() {
    this.servidor.registro.conexiones++;
    const ok = (this.cfg.accessToken && this.cfg.accessToken === this.servidor.accessToken)
      || (this.cfg.pass && this.cfg.pass === this.servidor.pass);
    if (!ok) throw Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });
  }

  async list() {
    const lista = [...this.servidor.carpetas.entries()].map(([path, c]) => ({
      path,
      name: path.split('/').pop(),
      delimiter: '/',
      flags: new Set(c.noselect ? ['\\Noselect', '\\HasChildren'] : []),
      specialUse: c.especial,
    }));
    return lista;
  }

  async mailboxOpen(path, opciones = {}) {
    this.servidor.registro.aperturas.push({ path, readOnly: opciones.readOnly === true });
    const c = this.servidor.carpetas.get(path);
    if (!c || c.noselect) {
      throw Object.assign(new Error("Mailbox doesn't exist: " + path), { mailboxMissing: true, responseStatus: 'NO' });
    }
    this.actual = path;
    return { path, uidValidity: BigInt(c.uidValidity), exists: c.mensajes.length };
  }

  async search(consulta) {
    const c = this.servidor.carpetas.get(this.actual);
    this.servidor.registro.busquedas.push({ carpeta: this.actual, consulta });
    if (consulta.uid) {
      const desde = Number(String(consulta.uid).split(':')[0]);
      const uids = c.mensajes.filter(m => m.uid >= desde).map(m => m.uid);
      // Comportamiento real de IMAP: "N:*" incluye siempre el último mensaje.
      if (!uids.length && c.mensajes.length) return [c.mensajes[c.mensajes.length - 1].uid];
      return uids;
    }
    if (consulta.since) return c.mensajes.filter(m => m.fecha >= consulta.since).map(m => m.uid);
    return c.mensajes.map(m => m.uid);
  }

  async *fetch(uids) {
    const c = this.servidor.carpetas.get(this.actual);
    this.servidor.registro.fetches.push({ carpeta: this.actual, uids: [...uids] });
    for (const uid of uids) {
      const m = c.mensajes.find(x => x.uid === uid);
      if (!m) continue;
      yield {
        uid,
        envelope: { from: [{ address: m.de }], subject: m.asunto, messageId: m.messageId, date: m.fecha },
        internalDate: m.fecha,
        source: Buffer.from(JSON.stringify({ ...m, fecha: m.fecha.toISOString() })),
      };
    }
  }

  async logout() { this.servidor.registro.logouts++; }
}

module.exports = { ServidorImapFalso };
