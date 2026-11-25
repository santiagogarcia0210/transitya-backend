// Requisitos por obra social para traslado de personas con discapacidad.
//
// Estado de cada obra social:
//   - Incluir Salud (paciente), OSPRERA (paciente/prestador) y Subsidio IPSST: cargados desde
//     documentos oficiales recibidos en nov 2026. Lo que el documento no aclara está marcado
//     "Vigencia no especificada: confirmar con la obra social".
//   - PAMI y los requisitos mensuales / de prestador conservados: BORRADOR de la práctica actual
//     de Transporte Flores y de instructivos públicos 2024-2025. Se validan con cada obra social.
//
// vencimiento:
//   'no'        → el documento no vence (DNI) o no se sabe: ver la nota del requisito
//   'fecha_doc' → vence en la fecha impresa en el documento (CUD, autorización)
//   'meses'     → vence N meses después de la fecha de emisión (vigenciaMeses)
//
// IMPORTANTE: la carpeta del paciente (services/legajos.js) une cada documento subido con su
// requisito por `key`. Cambiar la key de un requisito deja sin enlazar los documentos que ya se
// subieron con la anterior, así que donde el documento es el mismo se conservó la key de antes.

const R = (key, nombre, categoria, vencimiento, vigenciaMeses, extra = {}) => ({
  key, nombre, categoria, vencimiento, vigenciaMeses, obligatorio: true, condicion: '', notas: '', ...extra,
});

// Para los documentos oficiales: si la vigencia no está indicada (vencimiento 'no'), se deja
// asentado en la nota para no confundirlo con un documento que de verdad no vence.
const SIN_VIGENCIA = 'Vigencia no especificada: confirmar con la obra social';
const RO = (key, nombre, categoria, vencimiento, vigenciaMeses, extra = {}) =>
  R(key, nombre, categoria, vencimiento, vigenciaMeses, {
    ...extra,
    notas: vencimiento === 'no' ? [extra.notas, SIN_VIGENCIA].filter(Boolean).join(' ') : (extra.notas || ''),
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

// ── Incluir Salud: paciente según el documento oficial (10 requisitos, 9 obligatorios) ──────────
const INCLUIR_PACIENTE = [
  RO('nota_solicitud', 'Nota manuscrita original del beneficiario, padre o tutor, solicitando la prestación', 'paciente', 'no', 0),
  RO('dni', 'Fotocopia DNI del titular de derecho y del apoderado (acreditando vínculo)', 'paciente', 'no', 0),
  RO('cud', 'Fotocopia del Certificado Único de Discapacidad vigente a la fecha de solicitud', 'paciente', 'fecha_doc', 0,
    { notas: 'Debe estar vigente a la fecha de solicitud.' }),
  RO('boleta_haberes', 'Fotocopia de la última Orden de Pago Previsional (boleta de cobro)', 'paciente', 'no', 0),
  RO('pedido_medico', 'Prescripción médica original, indicando modalidad y período, con historia clínica firmada por profesional competente (diagnóstico, estado clínico actual y pronóstico)', 'paciente', 'no', 0),
  RO('informe_social', 'Informe de Trabajador Social matriculado', 'paciente', 'no', 0),
  RO('certificado_escolar', 'Certificado de incorporación y/o asistencia escolar', 'paciente', 'no', 0,
    { obligatorio: false, condicion: 'Solo para escuelas públicas' }),
  RO('presupuesto', 'Presupuesto de prestador de transporte habilitado con mapa georreferenciado', 'paciente', 'no', 0),
  RO('fim', 'Formulario de Medida de Independencia Funcional (FIM)', 'paciente', 'no', 0),
  RO('consolidado_egov', 'Autorización e-Gov del Plan de Trabajo al Centro', 'paciente', 'no', 0),
];

// ── OSPRERA: expedientes de discapacidad 2025, prestación de transporte ─────────────────────────
const OSPRERA_PACIENTE = [
  RO('recibos_titular', 'Copia de recibo de sueldo (uno de los tres meses anteriores al inicio del tratamiento)', 'paciente', 'meses', 3,
    { notas: 'Vale un recibo de cualquiera de los tres meses anteriores al inicio del tratamiento.' }),
  RO('dni', 'Copia DNI del titular y del beneficiario', 'paciente', 'no', 0),
  RO('dj_carnet_os', 'Copia de declaración jurada/carnet de la obra social', 'paciente', 'no', 0),
  RO('cud', 'Certificado de discapacidad vigente', 'paciente', 'fecha_doc', 0),
  RO('historia_clinica', 'Resumen de historia clínica firmado por médico tratante', 'paciente', 'no', 0),
  RO('pedido_medico', 'Prescripción de las prestaciones firmada por médico tratante', 'paciente', 'no', 0,
    { notas: 'Debe justificar la imposibilidad de usar transporte público. Sin tachaduras, con DNI, período escrito, sello y firma legible.' }),
  RO('conformidad_diagrama', 'Conformidad del diagrama de traslados firmada por la persona con discapacidad, familiar o tutor', 'paciente', 'no', 0,
    { notas: 'Incluye la declaración jurada de no haber accedido al beneficio de la Ley 19.279.' }),
  RO('presupuesto', 'Presupuesto de transporte con diagrama de traslados, firmado por la persona, familiar o tutor', 'paciente', 'no', 0,
    { notas: 'Origen y destino de cada viaje, km por viaje según el programa de georreferenciamiento y cronograma de traslado.' }),
  RO('google_maps', 'Google Maps firmado por el prestador y la persona o tutor', 'paciente', 'no', 0),
  RO('planilla_instituciones', 'Planilla de especialidades / instituciones / transporte', 'paciente', 'no', 0),
  RO('fim', 'Formulario de Escala FIM', 'paciente', 'no', 0,
    { obligatorio: false, condicion: 'Solo si hay dependencia',
      notas: 'El adicional por dependencia es del 35%, sujeto a evaluación. Debe confeccionarlo el médico tratante o Lic. en Terapia Ocupacional.' }),
  RO('certificado_policial', 'Certificado policial de residencia del paciente', 'paciente', 'no', 0,
    { obligatorio: false, condicion: 'Solo si los traslados superan 1500 km mensuales' }),
];

const OSPRERA_PRESTADOR = [
  RO('p_habilitacion', 'Habilitación', 'prestador', 'fecha_doc', 0),
  RO('p_seguro', 'Póliza de seguro', 'prestador', 'fecha_doc', 0),
  RO('p_vtv', 'Verificación Técnica Vehicular', 'prestador', 'fecha_doc', 0),
  RO('p_licencia', 'Licencia de conducir', 'prestador', 'fecha_doc', 0),
  RO('p_cuit', 'Constancia de CUIT', 'prestador', 'no', 0),
  RO('p_cbu', 'CBU', 'prestador', 'no', 0,
    { obligatorio: false, condicion: 'Solo prestador nuevo' }),
];

// ── Subsidio IPSST: nota al Instituto de Previsión y Seguridad Social de Tucumán ────────────────
const IPSST_PACIENTE = [
  RO('cud', 'Certificado de discapacidad', 'paciente', 'fecha_doc', 0),
  RO('pedido_medico', 'Pedido médico', 'paciente', 'no', 0),
  RO('informe_centro', 'Informe del centro o instituto al que asiste', 'paciente', 'no', 0),
  RO('certificado_afiliacion', 'Certificado de afiliación', 'paciente', 'no', 0),
  RO('acta_nacimiento', 'Acta de nacimiento', 'paciente', 'no', 0),
  RO('presupuesto', 'Presupuesto emitido por la empresa transportista', 'paciente', 'no', 0),
  RO('mapa_recorrido', 'Mapa indicativo del recorrido', 'paciente', 'no', 0),
];

const IPSST_PRESTADOR = [
  RO('p_habilitacion', 'Habilitación del servicio emitida por SI.PRO.SA.', 'prestador', 'fecha_doc', 0),
  RO('p_licencia', 'Carnet de conducir del chofer y DNI', 'prestador', 'fecha_doc', 0),
  RO('p_vtv', 'VTV del vehículo', 'prestador', 'fecha_doc', 0),
  RO('p_titulo_dominio', 'Título de dominio', 'prestador', 'no', 0),
  RO('p_seguro', 'Seguro del rodado', 'prestador', 'fecha_doc', 0),
  RO('p_constancias_tributarias', 'Constancias tributarias ARCA-DGR', 'prestador', 'no', 0),
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
      ...INCLUIR_PACIENTE,
      ...BASE_PRESTADOR,
      R('m_dj_esc107', 'DJ-ESC107 (planilla de conformidad efectiva de la prestación)', 'mensual', 'no', 0),
      ...BASE_MENSUAL,
    ],
    notas: 'Traslado programado, Programa Incluir Salud (Ministerio de Salud Pública de Tucumán). Requisitos de paciente según documento oficial. Documento oficial recibido, nov 2026. Los requisitos de prestador y los mensuales se conservan de la práctica actual de la empresa (sin cambios).',
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
      canal: 'Delegación Tucumán de OSPRERA (agencia Concepción para domicilios desde el límite sur de la provincia hasta Monteros)',
      notas: 'Recepción de carpetas: lunes, martes y miércoles de 08:00 a 12:00 en la delegación Tucumán de OSPRERA (agencia Concepción para domicilios desde el límite sur de la provincia hasta Monteros). La carpeta la presenta el responsable del afiliado; las correcciones las pueden presentar los prestadores. Límite de 25 afiliados por prestador individual. No se debe iniciar la prestación hasta que OSPRERA la autorice. Las carpetas pasan por auditoría administrativa y médica: presentarlas con la mayor anticipación posible. Contacto: discapacidad.tucuman@osprera.org.ar, teléfono 0381-4300768 interno 10.',
    },
    requisitos: [
      ...OSPRERA_PACIENTE,
      ...OSPRERA_PRESTADOR,
      R('m_autorizacion', 'Copia de la autorización vigente (va con cada factura)', 'mensual', 'no', 0),
      ...BASE_MENSUAL,
    ],
    notas: "Expedientes de discapacidad 2025, prestación de transporte. Fuente: documento 'Expedientes discapacidad 2025'. Documento oficial recibido, nov 2026. Requisitos 2025: confirmar vigencia para 2026. No se cargan los requisitos que son solo de terapias (informe de evaluación inicial, informe evolutivo, plan de abordaje individual, presupuesto prestacional, informe de seguimiento semestral): no aplican a transporte. Los requisitos mensuales se conservan de la práctica actual de la empresa (sin cambios).",
  },
  {
    id: 'subsidio-ipsst',
    nombre: 'Subsidio IPSST',
    alias: ['SUBSIDIO', 'IPSST'],
    presentacion: {
      // El sistema exige un día de 1 a 31 (por defecto 10): acá no significa nada, ver las notas.
      dia: 10,
      canal: 'Nota dirigida al Instituto de Previsión y Seguridad Social de Tucumán (IPSST)',
      notas: 'Se presenta por nota dirigida al IPSST adjuntando la documentación. Sin día de presentación fijo: el día 10 que muestra el sistema es solo un valor por defecto.',
    },
    requisitos: [
      ...IPSST_PACIENTE,
      ...IPSST_PRESTADOR,
    ],
    notas: 'Subsidio de transporte especial programado: se solicita por nota al Instituto de Previsión y Seguridad Social de Tucumán (IPSST). Documento oficial recibido, nov 2026.',
  },
];
