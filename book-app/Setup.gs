/**
 * 앱 설치용 — 한 번만 실행하면 됩니다.
 *
 * 이 앱은 봇(book-bot)이 만들어 둔 시트를 그대로 읽습니다.
 * 봇을 먼저 설치하고 사진을 몇 장 보내둔 뒤에 여기를 하세요.
 */

/** (보통 비워두세요) 자동 탐색이 실패할 때만 봇의 `상태확인` 에 찍힌 시트 ID를 넣습니다 */
const SHEET_ID_수동 = '';


/** 1단계 — 봇이 만든 시트를 찾아 연결합니다 */
function step1_저장소_연결() {
  const props = PropertiesService.getScriptProperties();

  if (SHEET_ID_수동) {
    connect_(SHEET_ID_수동.trim());
    return;
  }

  // 내 드라이브의 "독서노트" 폴더 안에 있는 스프레드시트를 찾는다
  const folders = DriveApp.getFoldersByName('독서노트');
  while (folders.hasNext()) {
    const files = folders.next().getFilesByType(MimeType.GOOGLE_SHEETS);
    while (files.hasNext()) {
      const f = files.next();
      try {
        const ss = SpreadsheetApp.openById(f.getId());
        if (ss.getSheetByName(PAGE_SHEET) && ss.getSheetByName(NOTE_SHEET)) {
          connect_(f.getId());
          return;
        }
      } catch (ignored) {}
    }
  }

  throw new Error(
    '시트를 찾지 못했습니다.\n' +
    '봇 프로젝트에서 step2_저장소_생성 을 먼저 실행했는지 확인하고,\n' +
    '그래도 안 되면 봇의 상태확인 에 찍힌 시트 ID를 이 파일의 SHEET_ID_수동 에 넣으세요.'
  );
}

function connect_(id) {
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', id);
  console.log('연결 완료: https://docs.google.com/spreadsheets/d/' + id);
  console.log('저장된 페이지 ' + rows_(PAGE_SHEET).length + '건, 노트 ' + rows_(NOTE_SHEET).length + '건');
  console.log('\n다음: 배포 → 새 배포 → 웹 앱 (실행: 나 / 액세스: 나만)');
}


/** 2단계 — 배포한 뒤 실행해서 연결이 제대로 됐는지 확인합니다 */
function step2_동작확인() {
  const books = api_books();
  console.log('책 ' + books.length + '권');
  books.forEach(function (b) {
    console.log('  ' + b.book + ' — ' + b.pages + '쪽, 하이라이트 ' + b.notes);
  });

  if (!books.length) {
    console.log('\n아직 저장된 페이지가 없습니다. 봇에 책 페이지를 몇 장 보내보세요.');
    return;
  }

  const pages = api_pages(books[0].book);
  const page = api_page(pages[0].id);
  console.log('\n가장 최근 페이지: ' + page.book + ' ' + (page.page || '?') + '쪽, 문장 ' + page.sentences.length + '개');
  console.log('첫 문장: ' + (page.sentences[0] ? page.sentences[0].text : '(없음)'));
  console.log('\n여기까지 나오면 앱도 정상입니다.');
}


/** 봇 답장에 앱 링크를 띄우고 싶을 때 — 여기 주소를 봇 프로젝트의 앱주소_등록 에 넣으세요 */
function 앱주소_확인() {
  const url = ScriptApp.getService().getUrl();
  console.log(url || '아직 배포되지 않았습니다. 먼저 웹 앱으로 배포하세요.');
  console.log('\n폰에서 이 주소를 열고 [홈 화면에 추가] 하면 앱처럼 씁니다.');
}
