// swal(sweetalert2) 기반 공용 다이얼로그 — native alert/prompt/confirm 대체.
import Swal from 'sweetalert2';

const base = {
  confirmButtonColor: '#2383e2',
  cancelButtonColor: '#9b9a97',
  buttonsStyling: true,
} as const;

export const dialog = {
  /** 확인/취소. 확인 시 true. */
  confirm: (title: string, text?: string, confirmText = '확인') =>
    Swal.fire({
      ...base,
      icon: 'warning',
      title,
      text,
      showCancelButton: true,
      confirmButtonText: confirmText,
      cancelButtonText: '취소',
    }).then((r) => r.isConfirmed),

  /** 텍스트 입력. 확인 시 입력값(빈 문자열 포함), 취소 시 null. */
  prompt: (title: string, value = '', placeholder = '') =>
    Swal.fire({
      ...base,
      title,
      input: 'text',
      inputValue: value,
      inputPlaceholder: placeholder,
      showCancelButton: true,
      confirmButtonText: '저장',
      cancelButtonText: '취소',
    }).then((r) => (r.isConfirmed ? r.value ?? '' : null)),

  /** 화자 설정 — 이름(별칭) + 색상. 확인 시 {name, color}, 취소 시 null. */
  speaker: (label: string, name = '', color = '#e03e3e') =>
    Swal.fire({
      ...base,
      title: `${label} 설정`,
      html:
        `<input id="sw-name" class="swal2-input" placeholder="이름 / 별칭 (예: 김부장)" value="${name.replace(/"/g, '&quot;')}">` +
        `<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:8px">` +
        `<span>색상</span><input id="sw-color" type="color" value="${color}" style="width:54px;height:36px;border:none;background:none;cursor:pointer"></div>`,
      showCancelButton: true,
      confirmButtonText: '저장',
      cancelButtonText: '취소',
      preConfirm: () => ({
        name: (document.getElementById('sw-name') as HTMLInputElement).value.trim(),
        color: (document.getElementById('sw-color') as HTMLInputElement).value,
      }),
    }).then((r) => (r.isConfirmed ? (r.value as { name: string; color: string }) : null)),

  /** 단순 알림. */
  alert: (title: string, text?: string) => Swal.fire({ ...base, title, text }),

  /** 오류 알림. */
  error: (text: string) => Swal.fire({ ...base, icon: 'error', title: '오류', text }),
};
