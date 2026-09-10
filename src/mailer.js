import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) return null;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

// Aviso por email de una consulta nueva del formulario de contacto. La
// consulta ya ha quedado guardada en la base de datos antes de llamar aqui -
// si el envio del email falla (SMTP caido, credenciales, etc.) no debe romper
// la respuesta al cliente, por eso nunca lanza el error hacia arriba.
export async function sendContactNotification({ name, email, phone, hotelOrZone, checkin, checkout, message }) {
  const to = process.env.CONTACT_NOTIFY_TO;
  const t = getTransporter();
  if (!t || !to) {
    console.warn('[mailer] SMTP o CONTACT_NOTIFY_TO no configurados, se omite el email');
    return;
  }

  try {
    await t.sendMail({
      from: `BedCopilot <${process.env.SMTP_USER}>`,
      to,
      subject: `Nueva consulta de contacto - BedCopilot`,
      text: [
        `Nombre: ${name || ''}`,
        `Email: ${email || ''}`,
        `Teléfono: ${phone || ''}`,
        `Hotel/zona: ${hotelOrZone || ''}`,
        `Fechas: ${checkin || ''} → ${checkout || ''}`,
        '',
        'Mensaje:',
        message || '',
      ].join('\n'),
    });
  } catch (err) {
    console.warn('[mailer] no se pudo enviar el email de aviso', err?.message);
  }
}
