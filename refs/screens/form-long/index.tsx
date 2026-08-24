/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-020（フォームの項目が多い）
 */
import { useState } from 'react'

const stages = ['基本情報', '詳細情報', '確認']

const FormLongScreen = () => {
  const [stage, setStage] = useState(0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <p style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', margin: 0 }}>
        {stage + 1} / {stages.length} — {stages[stage]}
      </p>
      <div style={{ minHeight: 'var(--sp-6)', fontSize: 'var(--fs-2)', color: 'var(--text)' }}>
        {stages[stage]} の入力欄
      </div>
      <button
        onClick={() => setStage((s) => Math.min(s + 1, stages.length - 1))}
        style={{
          alignSelf: 'flex-start',
          padding: 'var(--sp-2) var(--sp-3)',
          fontSize: 'var(--fs-2)',
          color: 'var(--bg)',
          background: 'var(--accent)',
          border: 'none',
          borderRadius: 'var(--radius-s)',
        }}
      >
        次へ進む
      </button>
    </div>
  )
}

export default FormLongScreen
