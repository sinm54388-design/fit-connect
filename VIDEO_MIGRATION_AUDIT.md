# FIT-CONNECT 영상 데이터 이전: 원본 대조 및 검증 계획

> **준비 문서 (실제 이전 미실행).** 2026-11-09에 저장된 Apps Script `Code.gs` 소스와 현재 미리보기 HTML의 표시/업로드 코드를 비교해 작성. 현재 배포된 Apps Script가 해당 소스와 동일한지는 검증 전이다. 회원의 실제 영상 메타데이터, 회원별 데이터 건수와 Drive 파일 존재 여부는 아직 확인하지 않았다.

## 확인한 원본

| 원본 시트 | 원본 컬럼(순서) | 목록 응답 | 새 테이블 매핑 |
| --- | --- | --- | --- |
| `ExerciseVideos` | `Member, Id, Name, Url, Tip`, 6번째 `FileId` 사용 | `{id,name,url,tip,fileId}` | member_id, kind=`exercise`, source_id, name, external_url, tip, file_id |
| `FormVideos` | `Member, Id, Name, FileId, Question, Feedback, Time, ReadAt` | `{id,name,fileId,question,feedback,time,readAt}` | member_id, kind=`form`, source_id, name, file_id, question, feedback, source_time, read_at |

**주의:** `ExerciseVideos` 시트 생성 코드는 5개 헤더만 넣지만 촬영 영상 업로드는 **6번째 열에 Drive FileId를 저장**한다. 따라서 단순히 헤더 이름만으로 추출하면 영상 연결이 누락될 수 있다. 이전 시 실제 열 번호를 검증해야 한다.

`FormVideos`의 `Time`과 `ReadAt`은 문자열로 표시되어 있다. 변환 과정에서 타임존/초 단위가 바뀌지 않게 `source_time`, `read_at`을 원문 그대로 저장한다. `raw_payload`에도 전체 원본을 보관한다.

## 원본 동작상 주의점

- 촬영 파일은 **Google Drive**에 저장되며 새 DB는 **파일 자체가 아닌 메타데이터**만 보관한다.
- `videoDownload`는 회원 토큰/트레이너 비밀번호를 확인하고, 해당 영상이 해당 회원 목록에 속하는지 검사한다. **목록 조회만 Supabase로 전환하면 기존 Drive 재생 권한 확인이 실패할 위험**이 있다. 실제 전환 전 인증 및 재생 경로를 함께 검증해야 한다.
- 트레이너가 `formVideoFeedback`을 수정하면 `ReadAt`이 비워진다. 이 동작을 새 DB에도 반영해야 한다.
- `markFormVideoRead`는 비어 있던 `ReadAt`을 처음 한 번 기록한다.
- `deleteFormVideo`는 원본 시트 행을 삭제하고 **Drive 파일을 휴지통으로 옮긴다**. 백업/마이그레이션 검증에서는 삭제 API를 절대 호출하지 않는다.
- 새 영상 업로드 `finishVideoUpload`, `addExerciseVideo` 및 관련 편집은 기존 Apps Script에 쓰기 때문에, **최초 백업 이후의 변경분을 재대조**해야 한다.
- 회원명과 `fit_members.id` 연결을 명시적으로 검증해야 한다. 이름만 비슷한 다른 회원에게 데이터를 합치지 않는다.
- 원본 행의 `Id`가 없거나 회원/종류 내 중복되면 자동으로 새 ID를 발급해 덮지 않고 검증 오류로 처리한다.

## 안전한 진행 순서

1. 배포된 Apps Script와 저장된 `Code.gs`의 영상 관련 함수가 같은지 검증한다. 차이가 있으면 현행 배포본 기준으로 매핑을 수정한다.
2. **읽기 전용** 방식으로 `ExerciseVideos`, `FormVideos`를 내보내고 원본 건수, 회원별 건수, `Id`, Drive `FileId`, 피드백·확인 기록을 검사한다. 실제 회원 데이터는 GitHub 저장소에 커밋하지 않는다.
3. 테스트 Supabase에서 `supabase-video-metadata-staging.sql`을 검토 후 실행한다. 서비스 키는 클라이언트나 GitHub에 넣지 않는다.
4. 백업 원본의 메타데이터를 **테스트 테이블에만** 적재하고 회원/종류/ID 기준으로 원본과 1:1 대조한다. 다른 값/누락/중복은 모두 차단한다.
5. 이후 Google Sheets에 생긴 새 영상과 수정된 피드백을 재대조한다.
6. 회원·트레이너별 실제 재생, 업로드, 피드백 수정, 확인 처리를 테스트한다. 기존 권한 검사와 링크는 유지한다.
7. 테스트 결과 일치가 확인된 후에만 미리보기 조회를 단계적으로 새 테이블로 전환한다. **실서비스와 원본 Drive/Sheets는 그대로 유지한다.**

## 아직 수행하지 않은 항목

- 실제 `ExerciseVideos`와 `FormVideos` 데이터 접근/백업
- 현재 배포 Apps Script 버전 검증
- Supabase 테이블 생성, 실제 INSERT/UPSERT, 업로드/삭제/재생 경로 수정
- 원본·사본 건수 및 파일 재생 검증

이 문서는 현재 확인 가능한 소스 코드를 정리한 계획이며, 실제 데이터 이전 성공을 의미하지 않는다.
