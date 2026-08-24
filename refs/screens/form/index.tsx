/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-014（エラー：入力）/ C-021（数値を入力させる）/ C-023（必須と任意が混在する）
 */
import { useState } from 'react'

const FormScreen = () => {
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const nameError = touched && name.trim() === '' ? '名前を入力してください' : null

  return (
    <form style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
        <span style={{ fontSize: 'var(--fs-2)', color: 'var(--text)' }}>名前</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(true)}
          style={{
            padding: 'var(--sp-2)',
            fontSize: 'var(--fs-2)',
            border: `1px solid ${nameError ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-s)',
          }}
        />
        {nameError && <span style={{ fontSize: 'var(--fs-1)', color: 'var(--accent)' }}>{nameError}</span>}
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
        <span style={{ fontSize: 'var(--fs-2)', color: 'var(--text)' }}>体重</span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-1)' }}>
          <input
            type="number"
            inputMode="decimal"
            style={{
              padding: 'var(--sp-2)',
              fontSize: 'var(--fs-2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-s)',
            }}
          />
          <span style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)' }}>kg</span>
        </div>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
        <span style={{ fontSize: 'var(--fs-2)', color: 'var(--text)' }}>
          メモ <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-1)' }}>（任意）</span>
        </span>
        <textarea
          style={{
            padding: 'var(--sp-2)',
            fontSize: 'var(--fs-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-s)',
          }}
        />
      </label>
    </form>
  )
}

export default FormScreen
