// api/notion.js
export default async function handler(req, res) {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = process.env.NOTION_DATABASE_ID;

  if (!NOTION_TOKEN || !DATABASE_ID) {
    return res.status(500).json({ error: "Vercel 환경변수(NOTION_TOKEN, NOTION_DATABASE_ID)가 설정되지 않았습니다." });
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };

  try {
    // 1. GET Request: 노션 DB에서 기존 데이터 조회 (자동 양방향 동기화용)
    if (req.method === 'GET') {
      const queryRes = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ page_size: 100 })
      });
      const queryData = await queryRes.json();
      return res.status(200).json(queryData);
    }

    // 2. POST Request: 노션 DB에 날짜별 페이지 생성 및 상세 학습 내용 정리 기록
    if (req.method === 'POST') {
      const { date, plannerData } = req.body;
      const targetDate = date || new Date().toISOString().split('T')[0];

      // 이미 해당 날짜로 만든 페이지가 있는지 조회
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          filter: {
            property: 'Title',
            title: { equals: targetDate }
          }
        })
      });
      const searchData = await searchRes.json();

      // 노션 페이지 본문에 들어갈 블록(학습 정리 기록) 생성
      const blocks = buildNotionBlocks(targetDate, plannerData);

      if (searchData.results && searchData.results.length > 0) {
        // 기존 페이지가 존재하는 경우 : 기존 내용 하단에 새로운 기록 블록 추가
        const pageId = searchData.results[0].id;
        
        await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ children: blocks })
        });

        return res.status(200).json({ success: true, action: 'updated', pageId });
      } else {
        // 기존 페이지가 없는 경우 : 신규 페이지 생성 (Title: 날짜, Date: 날짜)
        const createRes = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            parent: { database_id: DATABASE_ID },
            properties: {
              Title: {
                title: [{ text: { content: targetDate } }]
              },
              Date: {
                date: { start: targetDate }
              }
            },
            children: blocks
          })
        });
        const createData = await createRes.json();
        return res.status(200).json({ success: true, action: 'created', data: createData });
      }
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// 노션 페이지 내부 본문(Block) 상세 기록 작성 헬퍼 함수
function buildNotionBlocks(dateStr, data) {
  if (!data) return [];

  const blocks = [
    {
      object: 'block',
      type: 'heading_1',
      heading_1: {
        rich_text: [{ type: 'text', text: { content: `📅 ${dateStr} 학습 종합 스탯 및 일지` } }]
      }
    },
    {
      object: 'block',
      type: 'divider',
      divider: {}
    }
  ];

  // 1. 순공 시간 및 당일 플랜 기록
  const todayTasks = data.tasks?.[dateStr] || [];
  const todayStudyTime = data.studyTimes?.[dateStr] || '기록 없음';
  
  blocks.push({
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: `⏱️ 당일 학습 요약 (순공시간: ${todayStudyTime})` } }] }
  });

  if (todayTasks.length > 0) {
    todayTasks.forEach(task => {
      blocks.push({
        object: 'block',
        type: 'to_do',
        to_do: {
          rich_text: [{ type: 'text', text: { content: task.text } }],
          checked: !!task.completed
        }
      });
    });
  } else {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: '등록된 당일 플랜이 없습니다.' } }] }
    });
  }

  // 2. 인강 현황 (시작일, 완강일, 걸린 기간 등)
  if (data.lectures && data.lectures.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: '🎧 인강 수강 및 완강 기록' } }] }
    });

    data.lectures.forEach(lec => {
      const startDate = lec.startDate || '미지정';
      const endDate = lec.endDate || (lec.current >= lec.total ? '완강 완료' : '진행 중');
      const duration = lec.duration ? `${lec.duration}일 소요` : '진행 중';
      const statusText = `[${lec.subject}] ${lec.title} (${lec.instructor || '교수미상'}) | 진행률: ${lec.current}/${lec.total}강 | 시작일: ${startDate} | 완강일: ${endDate} (${duration})`;

      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ type: 'text', text: { content: statusText } }]
        }
      });
    });
  }

  // 3. N 회독 기록 (회독 시작일, 완강/끝낸 날, 걸린 기간)
  if (data.reviews && data.reviews.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: '📖 회독 회차별 상세 이력' } }] }
    });

    data.reviews.forEach(book => {
      (book.chapters || []).forEach(ch => {
        const chStart = ch.startDate || '기록 없음';
        const chEnd = ch.endDate || '진행 중';
        const chDur = ch.duration ? `${ch.duration}일` : '-';
        const chText = `📘 [${book.subject}] ${book.title} - ${ch.title} : ${ch.count || 0}회독 진행 중 (시작: ${chStart} / 종료: ${chEnd} / 소요: ${chDur})`;

        blocks.push({
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [{ type: 'text', text: { content: chText } }]
          }
        });
      });
    });
  }

  return blocks;
}