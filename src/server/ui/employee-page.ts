/** Static, self-contained V4 presentation; no authentication or action authority. */
export const EMPLOYEE_PAGE_STYLES = `
@font-face{font-family:Geist;src:url('/fonts/Geist.ttf') format('truetype');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:#f6f8fb;color:#202c3e;font:13px/1.6 Geist,'Segoe UI',sans-serif;padding:48px 24px;font-synthesis:none}
.employee-secure{max-width:680px;margin:0 auto}.employee-brand{font-weight:600;font-size:20px;letter-spacing:-.6px;margin-bottom:24px;color:#242d3b}.employee-brand span{display:inline-grid;place-items:center;width:34px;height:34px;background:#215fce;border-radius:11px;color:white;font-size:26px;margin-right:9px}
.employee-card{background:#fff;border:1px solid #e5eaf0;border-radius:14px;padding:28px;box-shadow:0 12px 48px #25354a08}
.employee-eyebrow{font-size:12px;letter-spacing:.5px;font-weight:550;color:#5b697e;margin:0 0 12px}
h1{font-size:28px;line-height:36px;font-weight:650;letter-spacing:-.9px;margin:0 0 16px}
p{color:#5b697e}strong{color:#202c3e}
label{display:grid;gap:6px;margin:20px 0;font-weight:550;font-size:12px}
textarea,input{width:100%;font:inherit;border:1px solid #d9e1ec;border-radius:7px;padding:8px 10px;color:#202c3e;background:white;min-height:38px}
textarea{min-height:112px;resize:vertical}
button{font:inherit;background:#215fce;color:#fff;border:1px solid #215fce;border-radius:8px;padding:7px 12px;min-height:36px;font-weight:550;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}a{color:#215fce;text-underline-offset:3px;overflow-wrap:anywhere}
button:hover:not(:disabled){background:#194eae}
button:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid #397cdb;outline-offset:3px}
[role=alert]{color:#a32d46;margin-top:20px;overflow-wrap:anywhere}.success{color:#21644e!important}
.employee-summary{border:1px solid #e5eaf0;border-radius:10px;background:#f8fafc;padding:16px}
.employee-return{margin:24px 0 0}.employee-return a{display:inline-flex;min-height:36px;align-items:center;border:1px solid #dce3ec;border-radius:8px;background:#fff;padding:7px 12px;color:#344359;font-weight:550;text-decoration:none}
.employee-secure-auth{max-width:480px}
@media(max-width:600px){body{padding:24px 16px}.employee-card{padding:20px;border-radius:14px}h1{font-size:24px;line-height:32px}button{width:100%;white-space:normal;min-height:44px}input,textarea{min-height:44px;font-size:16px}.employee-summary{overflow-wrap:anywhere}}
`;
export const EMPLOYEE_BRAND =
  '<div class="employee-brand"><span aria-hidden="true">m</span>Mayı Sigorta</div>';
