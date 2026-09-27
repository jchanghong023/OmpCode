import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import forge from "node-forge";
import { MOBILE_RELAY_PUBLIC_ORIGIN } from "./mobileRelayProtocol.js";

/**
 * 手机远控内嵌中继的自签证书。
 *
 * 结构：自签 CA（10 年，CA:TRUE）+ CA 签发的 server leaf（SAN 覆盖公网 IP、
 * 127.0.0.1、localhost）。手机端把导出的 CA 证书安装为用户 CA（ompMobile 的
 * debug 构建信任用户 CA），即可通过 wss://8.137.101.112/ws 完成链验证；
 * 公网链路本身是 frp TCP 透传，TLS 端到端终止在本 relay。
 *
 * 证书持久化在用户数据目录：CA 密钥固定复用，避免每次启动换证书导致手机
 * 需要重新安装信任锚。
 */

const CA_VALIDITY_YEARS = 10;
const LEAF_VALIDITY_YEARS = 10;

export interface MobileRelayCertificate {
  caPem: string;
  certPem: string;
  keyPem: string;
}

function yearsLater(date: Date, years: number): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

function generateCertificatePair(): MobileRelayCertificate {
  const notBefore = new Date(Date.now() - 24 * 3600 * 1000);

  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const ca = forge.pki.createCertificate();
  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = String(Date.now());
  ca.validity.notBefore = notBefore;
  ca.validity.notAfter = yearsLater(notBefore, CA_VALIDITY_YEARS);
  ca.setSubject([{ name: "commonName", value: "OmpCode Mobile Relay CA" }]);
  ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", critical: true, keyCertSign: true, cRLSign: true },
  ]);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = leafKeys.publicKey;
  leaf.serialNumber = String(Date.now()) + Math.floor(Math.random() * 1_000_000);
  leaf.validity.notBefore = notBefore;
  leaf.validity.notAfter = yearsLater(notBefore, LEAF_VALIDITY_YEARS);
  leaf.setSubject([{ name: "commonName", value: "OmpCode Mobile Relay" }]);
  leaf.setIssuer(ca.subject.attributes);
  // type 2 = DNS（value 传字符串）；type 7 = IP 必须走 forge 的 `ip` 字段并传点分
  // 字符串，由 forge 编码为 4 字节 octet——误用 value 会把字符串原样编成 13 字节
  // 的无效 SAN（Android 实测 net_error -200 证书主机名不匹配）。
  const publicHost = new URL(MOBILE_RELAY_PUBLIC_ORIGIN).hostname;
  leaf.setExtensions([
    {
      name: "subjectAltName",
      altNames: [
        { type: 7, ip: publicHost },
        { type: 7, ip: "127.0.0.1" },
        { type: 2, value: "localhost" },
      ],
    },
    { name: "extKeyUsage", serverAuth: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
  ]);
  leaf.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    caPem: forge.pki.certificateToPem(ca),
    certPem: forge.pki.certificateToPem(leaf),
    keyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
  };
}

/** 加载或生成 relay 证书；写入用户数据目录 mobile-relay/ 下固定文件名。 */
export async function loadOrCreateMobileRelayCertificate(
  userDataPath: string,
): Promise<MobileRelayCertificate> {
  const dir = join(userDataPath, "mobile-relay");
  const caPath = join(dir, "ca.pem");
  const certPath = join(dir, "server.crt");
  const keyPath = join(dir, "server.key");
  const caExportPath = join(dir, "ca-export.pem");

  try {
    const [caPem, certPem, keyPem] = await Promise.all([
      readFile(caPath, "utf8"),
      readFile(certPath, "utf8"),
      readFile(keyPath, "utf8"),
    ]);
    // 已有证书要能通过解析校验；损坏则回退重新生成。
    forge.pki.certificateFromPem(certPem);
    forge.pki.privateKeyFromPem(keyPem);
    return { caPem, certPem, keyPem };
  } catch {
    // 首次启动或证书损坏：整体重新生成并落盘。
  }

  const generated = generateCertificatePair();
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(caPath, generated.caPem, "utf8"),
    writeFile(certPath, generated.certPem, "utf8"),
    // 私钥仅存本机用户数据目录，权限交给用户目录默认 ACL，不写入日志。
    writeFile(keyPath, generated.keyPem, "utf8"),
    // CA 公证书导出副本，命名明确：拷到手机安装为用户 CA。
    writeFile(caExportPath, generated.caPem, "utf8"),
  ]);
  return generated;
}
