import { authorize } from "../_lib/authz.js";
import { json, errorJson } from "../_lib/http.js";

export async function onRequestGet(context) {
  try {
    const { user } = await authorize(context);
    return json({
      ok: true,
      email: user.email,
      user: user.name,
      accessRaw: user.accessRaw,
      branchRaw: user.branchRaw,

      reportAccess: user.reportAccess.tokens,
      reportAccessAll: user.reportAccess.all,

      // Backward-compatible names used by older standalone report guards.
      access: user.reportAccess.tokens,
      accessAll: user.reportAccess.all,
      all: user.reportAccess.all,
      allReports: user.reportAccess.all,

      branchAccess: user.branchAccess.tokens,
      branchAccessAll: user.branchAccess.all
    });
  } catch (e) {
    return errorJson(e?.message || "Access check failed", Number(e?.status || 500), e?.code || "access_check_failed");
  }
}
