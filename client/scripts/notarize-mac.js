'use strict';

/**
 * electron-builder afterSign：mac 公证，对 Apple notarytool 超时/网络错误重试。
 * CI 上常见 NSURLErrorDomain -1001，内置 notarize:true 失败即整包退出。
 */
const path = require('path');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableNotarizeError(err) {
  const msg = String((err && err.message) || err || '');
  return /timed out|timeout|-1001|NSURLError|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|503|502|504|unexpected result/i.test(msg);
}

exports.default = async function notarizeMac(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  // 无凭证时跳过（本地未配置签名公证）
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize-mac] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID 未齐，跳过公证');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  // 与 electron-builder 一并安装的传递依赖
  const { notarize } = require('@electron/notarize');

  const maxAttempts = Number(process.env.NOTARIZE_MAX_ATTEMPTS || 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(`[notarize-mac] 开始公证 (${attempt}/${maxAttempts}): ${appPath}`);
      await notarize({
        appPath,
        appleId,
        appleIdPassword,
        teamId,
      });
      console.log('[notarize-mac] 公证成功');
      return;
    } catch (err) {
      const retryable = isRetryableNotarizeError(err);
      console.warn(`[notarize-mac] 第 ${attempt} 次失败:`, err && err.message ? err.message : err);
      if (!retryable || attempt >= maxAttempts) throw err;
      const waitMs = 20000 * attempt;
      console.warn(`[notarize-mac] 可重试错误，${waitMs / 1000}s 后重试…`);
      await sleep(waitMs);
    }
  }
};
