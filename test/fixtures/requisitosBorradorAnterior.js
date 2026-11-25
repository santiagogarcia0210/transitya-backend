// COPIA CONGELADA del borrador de requisitos tal como estaba antes de cargar los documentos
// oficiales (nov 2026). Sirve para dos cosas en las pruebas: simular una empresa que ya cargó el
// borrador viejo, y demostrar que PAMI, los mensuales y los requisitos de prestador de Incluir
// Salud no cambiaron. No se usa en producción: no editar.
// BORRADOR de requisitos por obra social para traslado de personas con discapacidad.
// Fuentes: práctica actual de Transporte Flores (recibo de Presentación Docs de Incluir Salud),
// Res. SSSalud 360/2022 (Mecanismo de Integración, aplica a obras sociales nacionales como OSPRERA)
// e instructivos públicos de discapacidad 2024-2025 de obras sociales nacionales.
// TODO lo marcado "confirmar" debe validarse con cada obra social / UGP antes de usarse en serio.
//
// vencimiento:
//   'no'        → el documento no vence (DNI)
//   'fecha_doc' → vence en la fecha impresa en el documento (CUD, autorización)
//   'meses'     → vence N meses después de la fecha de emisión (vigenciaMeses)

const R = (key, nombre, categoria, vencimiento, vigenciaMeses, extra = {}) => ({
  key, nombre, categoria, vencimiento, vigenciaMeses, obligatorio: true, condicion: '', notas: '', ...extra,
});

const BASE_PACIENTE = [
  R('dni', 'DNI del paciente (frente y dorso)', 'paciente', 'no', 0),
  R('cud', 'Certificado Único de Discapacidad (CUD) vigente', 'paciente', 'fecha_doc', 0,
    { notas: 'Si está vencido, presentar prórroga o el certificado renovado.' }),
  R('pedido_medico', 'Pedido / prescripción médica de transporte', 'paciente', 'meses', 12,
    { notas: 'Firma y sello del médico tratante, especialidad acorde al diagnóstico del CUD. Debe indicar diagnóstico, cantidad de viajes, período, origen y destino.' }),
  R('fim', 'Escala FIM (Medida de Independencia Funcional)', 'paciente', 'meses', 12,
    { notas: 'Informe cualitativo y cuantitativo. Confirmar quién debe firmarlo (médico tratante o Lic. en Terapia Ocupacional).' }),
  R('presupuesto', 'Presupuesto de transporte con diagrama de traslados', 'paciente', 'meses', 12,
    { notas: 'Origen y destino de cada viaje, km por viaje, cronograma semanal, valor por km y monto mensual.' }),
  R('conformidad_diagrama', 'Conformidad del diagrama de traslados (firma paciente o familiar)', 'paciente', 'meses', 12),
  R('constancia_institucion', 'Constancia de asistencia del centro / escuela de destino', 'paciente', 'meses', 12,
    { notas: 'Renovar por ciclo lectivo o tratamiento.' }),
  R('autorizacion', 'Autorización de la prestación emitida por la obra social', 'paciente', 'fecha_doc', 0,
    { notas: 'Cargar la fecha de fin del período autorizado.' }),
  R('dependencia', 'Justificación de dependencia + DNI del acompañante', 'paciente', 'meses', 12,
    { obligatorio: false, condicion: 'Solo si se factura dependencia', notas: 'El médico debe justificar que el paciente no puede usar transporte público.' }),
];

const BASE_PRESTADOR = [
  R('p_arca', 'Constancia de inscripción ARCA vigente', 'prestador', 'no', 0),
  R('p_seguro', 'Póliza de seguro del vehículo (uso comercial / transporte de personas)', 'prestador', 'fecha_doc', 0,
    { notas: 'No se aceptan pólizas de uso particular.' }),
  R('p_vtv', 'VTV de cada vehículo', 'prestador', 'fecha_doc', 0),
  R('p_habilitacion', 'Habilitación municipal / provincial del transporte', 'prestador', 'fecha_doc', 0),
  R('p_licencia', 'Licencia de conducir profesional de cada chofer', 'prestador', 'fecha_doc', 0),
  R('p_dni_chofer', 'DNI de cada chofer', 'prestador', 'no', 0),
];

const BASE_MENSUAL = [
  R('m_planilla', 'Planilla de asistencia del mes firmada', 'mensual', 'no', 0,
    { notas: 'Firmas: transportista, paciente o familiar e institución que recibe.' }),
  R('m_factura', 'Factura electrónica del período', 'mensual', 'no', 0,
    { notas: 'Fecha de emisión dentro del período facturado. Detallar paciente, DNI, km y período.' }),
];

module.exports = [
  {
    id: 'incluir-salud',
    nombre: 'Incluir Salud',
    alias: ['INCLUIR', 'PROFE', 'INCLUIR SALUD'],
    presentacion: {
      dia: 10,
      canal: 'UGP Tucumán (confirmar)',
      notas: 'Planilla de conformidad efectiva de la prestación + DJ-ESC107 por paciente, con la factura. Tope 880 km/mes por paciente.',
    },
    requisitos: [
      R('nota_solicitud', 'Nota manuscrita de solicitud de autorización de transporte', 'paciente', 'meses', 12),
      ...BASE_PACIENTE.filter(r => !['conformidad_diagrama', 'constancia_institucion'].includes(r.key)),
      R('boleta_haberes', 'Boleta de haberes (vigencia no mayor a 30 días)', 'paciente', 'meses', 1),
      R('historia_clinica', 'Historia clínica', 'paciente', 'meses', 12),
      R('informe_social', 'Informe social', 'paciente', 'meses', 12),
      R('consolidado_egov', 'Consolidado e-Gov (publicación de autorización)', 'paciente', 'fecha_doc', 0),
      R('hoja_ruta', 'Hoja de ruta', 'paciente', 'meses', 12),
      ...BASE_PRESTADOR,
      R('m_dj_esc107', 'DJ-ESC107 (planilla de conformidad efectiva de la prestación)', 'mensual', 'no', 0),
      ...BASE_MENSUAL,
    ],
    notas: 'BORRADOR. Lista de paciente tomada del recibo de Presentación Docs que ya usa la empresa.',
  },
  {
    id: 'pami',
    nombre: 'PAMI',
    alias: ['PAMI', 'INSSJP'],
    presentacion: {
      dia: 10,
      canal: 'UGL Tucumán (confirmar)',
      notas: 'Sin tope de km. Confirmar formato de planilla y circuito de facturación con la UGL.',
    },
    requisitos: [
      R('credencial', 'Credencial de afiliación PAMI', 'paciente', 'no', 0),
      ...BASE_PACIENTE,
      ...BASE_PRESTADOR,
      ...BASE_MENSUAL,
    ],
    notas: 'BORRADOR. Requisitos públicos de PAMI: CUD, orden médica que justifique el traslado, establecimiento que certifique la necesidad y presupuesto de un transportista prestador.',
  },
  {
    id: 'osprera',
    nombre: 'OSPRERA',
    alias: ['OSPRERA'],
    presentacion: {
      dia: 10,
      canal: 'Delegación OSPRERA / portal de discapacidad (confirmar)',
      notas: 'Obra social nacional: rige el Mecanismo de Integración (Res. SSSalud 360/2022). Las fechas de cierre las fija el cronograma de la SSSalud. Sin tope de km.',
    },
    requisitos: [
      R('cuil', 'Constancia de CUIL (titular y paciente)', 'paciente', 'no', 0),
      R('recibos_titular', 'Últimos 3 recibos de sueldo del titular', 'paciente', 'meses', 3,
        { notas: 'Confirmar si OSPRERA lo pide (lo piden varias obras sociales nacionales).' }),
      ...BASE_PACIENTE,
      ...BASE_PRESTADOR,
      R('p_registro_sss', 'Inscripción en el Registro Nacional de Prestadores (SSSalud)', 'prestador', 'fecha_doc', 0),
      R('p_alta_proveedor', 'Formulario de alta de proveedor (anual)', 'prestador', 'meses', 12),
      R('m_autorizacion', 'Copia de la autorización vigente (va con cada factura)', 'mensual', 'no', 0),
      ...BASE_MENSUAL,
    ],
    notas: 'BORRADOR basado en Res. SSSalud 360/2022 e instructivos de otras obras sociales nacionales. Confirmar con OSPRERA.',
  },
];
