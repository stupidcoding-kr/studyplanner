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
    return res.status(200).end();
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
    // 1. GET Request: 노션 DB에서 기존 데이터 조회
    if (req.method === 'GET') {
      const queryRes = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ page_size: 100 })
      });
      const queryData = await queryRes.json();
      return res.status(200).json(queryData);
    }

    // 2. POST Request: 노션 DB에 날짜별 페이지 생성 및 기록
    if (req.method === 'POST') {
      const { date, summary, plannerData } = req.body || {};
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

      // 노션 본문 블록 생성 (summary 전달 포함)
      const blocks = buildNotionBlocks(targetDate, plannerData, summary);

      if (searchData.results && searchData.results.length > 0) {
        // 기존 페이지가 존재하는 경우 : 기존 블록 삭제 후 재작성
        const pageId = searchData.results[0].id;

        const existingBlocksRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
          method: 'GET',
          headers
        });
        const existingBlocksData = await existingBlocksRes.json();

        if (existingBlocksData.results && existingBlocksData.results.length > 0) {
          await Promise.all(
            existingBlocksData.results.map(block =>
              fetch(`https://api.notion.com/v1/blocks/${block.id}`, {
                method: 'DELETE',
                headers
              })
            )
          );
        }

        await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ children: blocks })
        });

        return res.status(200).json({ 
          success: true, 
          action: 'updated', 
          pageId, 
          message: "오늘의 리포트가 성공적으로 업데이트되었습니다." 
        });
      } else {
        // 신규 페이지 생성
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
        return res.status(200).json({ 
          success: true, 
          action: 'created', 
          data: createData, 
          message: "오늘의 리포트가 새로 생성되었습니다." 
        });
      }
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// 노션 페이지 본문(Block) 상세 기록 작성 헬퍼 함수
function buildNotionBlocks(dateStr, data, summary) {
  const blocks = [];

  // 1. 메인 타이틀
  blocks.push({
    object: 'block',
    type: 'heading_1',
    heading_1: {
      rich_text: [{ type: 'text', text: { content: `📅 ${dateStr} 학습 종합 일지` } }]
    }
  });

  // 2. 총평 및 요약 (summary 전달 시 인용구 블록으로 작성)
  if (summary) {
    blocks.push({
      object: 'block',
      type: 'quote',
      quote: {
        rich_text: [{ type: 'text', text: { content: summary } }]
      }
    });
  }

  if (!data) return blocks;

  // 3. 당일 순공시간 및 플랜 달성률 요약 (Callout 박스)
  const todayTasks = data.tasks?.[dateStr] || [];
  const todayStudyTime = data.studyTimes?.[dateStr] || '기록 없음';
  const completedCount = todayTasks.filter(t => t.completed).length;
  const achieveRate = todayTasks.length > 0 ? Math.round((completedCount / todayTasks.length) * 100) : 0;

  blocks.push({
    object: 'block',
    type: 'callout',
    callout: {
      icon: { emoji: '⏱️' },
      color: 'blue_background',
      rich_text: [
        { type: 'text', text: { content: '당일 순공시간: ' }, annotations: { bold: true } },
        { type: 'text', text: { content: `${todayStudyTime}  |  ` } },
        { type: 'text', text: { content: '플랜 달성률: ' }, annotations: { bold: true } },
        { type: 'text', text: { content: `${achieveRate}% (${completedCount}/${todayTasks.length} 완료)` } }
      ]
    }
  });

  blocks.push({ object: 'block', type: 'divider', divider: {} });

  // 4. 당일 플랜 (To-Do List)
  blocks.push({
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: '✅ 당일 학습 플랜' } }]
    }
  });

  if (todayTasks.length > 0) {
    todayTasks.forEach(task => {
      blocks.push({
        object: 'block',
        type: 'to_do',
        to_do: {
          rich_text: [{ type: 'text', text: { content: task.text || task.title || String(task) } }],
          checked: !!task.completed
        }
      });
    });
  } else {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: '등록된 당일 플랜이 없습니다.', annotations: { italic: true, color: 'gray' } } }]
      }
    });
  }

  // 5. 인강 수강 현황
  if (data.lectures && data.lectures.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ type: 'text', text: { content: '🎧 인강 수강 현황' } }]
      }
    });

    data.lectures.forEach(lec => {
      const pct = lec.total > 0 ? Math.min(100, Math.round(((lec.current || 0) / lec.total) * 100)) : 0;
      const startDate = lec.startDate || '미지정';
      const isFinished = lec.current >= lec.total;
      const endDate = lec.endDate || (isFinished ? '완강' : '진행 중');

      const statusDetail = isFinished
        ? `완강 완료 (${endDate})`
        : `진행 중 (시작일: ${startDate})`;

      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { type: 'text', text: { content: `[${lec.subject}] ` }, annotations: { bold: true, color: 'blue' } },
            { type: 'text', text: { content: `${lec.title} ` }, annotations: { bold: true } },
            { type: 'text', text: { content: `(${lec.instructor || '교수미상'})` }, annotations: { color: 'gray' } },
            { type: 'text', text: { content: `\n   진행률: ${lec.current}/${lec.total}강 (${pct}%) · ${statusDetail}` }, annotations: { color: 'gray' } }
          ]
        }
      });
    });
  }

  // 6. 회독 상세 이력 (장 및 절 계층구조 반영)
  if (data.reviews && data.reviews.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ type: 'text', text: { content: '📖 회독 상세 이력' } }]
      }
    });

    data.reviews.forEach(book => {
      if (!book.chapters || book.chapters.length === 0) return;

      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            { type: 'text', text: { content: `📘 [${book.subject}] ${book.title}` }, annotations: { bold: true } }
          ]
        }
      });

      book.chapters.forEach(ch => {
        const chStart = ch.startDate || '-';
        const chEnd = ch.endDate || '진행 중';

        blocks.push({
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [
              { type: 'text', text: { content: `   • ${ch.title}: ` } },
              { type: 'text', text: { content: `${ch.count || 0}회독` }, annotations: { bold: true, color: 'blue' } },
              { type: 'text', text: { content: ` (기간: ${chStart} ~ ${chEnd})` }, annotations: { color: 'gray' } }
            ]
          }
        });

        (ch.sections || []).forEach(sec => {
          const secStart = sec.startDate || '-';
          const secEnd = sec.endDate || '진행 중';

          blocks.push({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: {
              rich_text: [
                { type: 'text', text: { content: `      - ${sec.title}: ` } },
                { type: 'text', text: { content: `${sec.count || 0}회독` }, annotations: { bold: true, color: 'green' } },
                { type: 'text', text: { content: ` (${secStart} ~ ${secEnd})` }, annotations: { color: 'gray' } }
              ]
            }
          });
        });
      });
    });
  }

  return blocks;
}
