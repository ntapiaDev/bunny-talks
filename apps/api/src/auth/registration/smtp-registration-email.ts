import { createTransport } from 'nodemailer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { loginEmailSchema } from '@bunny-talks/validation';
import { parseOpaqueToken } from '../sessions/session-token.js';
import type { RegistrationEmailTransport } from './postgres-email-registration.js';
import type { RegistrationConfig } from './registration-config.js';
import { RegistrationError } from './registration-policy.js';

/** Real SMTP only. TLS certificate verification is mandatory, including in development. */
export class SmtpRegistrationEmail implements RegistrationEmailTransport {
  public constructor(private readonly config: RegistrationConfig['smtp']) {}

  private options() {
    return {
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      requireTLS: !this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const },
      connectionTimeout: this.config.timeoutMs,
      greetingTimeout: this.config.timeoutMs,
      socketTimeout: this.config.timeoutMs,
      dnsTimeout: this.config.timeoutMs,
      logger: false as const,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      name: 'bunny-talks',
    };
  }

  /** Nodemailer's documented SMTPConnection API permits closing an entire timed-out probe. */
  public async checkAvailability(): Promise<void> {
    const connection = new SMTPConnection(this.options());
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          connection.close();
          reject(new Error('timeout'));
        }, this.config.timeoutMs);
        const finish = (error?: Error | null) => {
          clearTimeout(timer);
          connection.close();
          if (error) reject(error);
          else resolve();
        };
        connection.once('error', finish);
        connection.connect((error?: Error | null) => {
          if (error) {
            finish(error);
            return;
          }
          connection.login({ user: this.config.user, pass: this.config.password }, finish);
        });
      });
    } catch {
      throw new RegistrationError('DELIVERY_UNAVAILABLE');
    } finally {
      connection.close();
    }
  }

  public async submitVerification(
    message: Readonly<{ to: string; token: string; expiresAt: Date }>,
  ): Promise<void> {
    const transporter = createTransport(this.options());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      if (
        !loginEmailSchema.safeParse(message.to).success ||
        !Number.isFinite(message.expiresAt.getTime())
      )
        throw new Error('Invalid message');
      const proof = parseOpaqueToken(message.token, 'e1');
      proof.hash.fill(0);
      const result = await transporter.sendMail({
        from: { name: 'Bunny Talks', address: this.config.from },
        to: { address: message.to, name: '' },
        envelope: { from: this.config.from, to: [message.to] },
        subject: 'Verify your Bunny Talks email',
        // No GET endpoint or URL: mailbox scanners cannot consume this proof.
        text: `Open Bunny Talks and paste this verification proof:\n\n${message.token}\n\nExpires at ${message.expiresAt.toISOString()}.\nIf you did not request this, ignore this message.`,
        signal: controller.signal,
      });
      if (result.accepted.length !== 1 || result.rejected.length !== 0) throw new Error('Rejected');
    } catch {
      throw new RegistrationError('DELIVERY_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      transporter.close();
    }
  }
}
