import { useState } from 'react';
import { Trash2, UserRound } from 'lucide-react';
import { applyProductionChange, type ProductionEntity } from '../../services/tauri';
import { subjectKindLabel } from '../../domain/production/labels';
import { payloadText } from './payloadText';

export function SubjectLibrary({ projectId, subjects, busy, onAdd, onRefresh, onDelete }: { projectId?: string; subjects: ProductionEntity[]; busy: boolean; onAdd: (name: string, kind: string, descriptor: string) => void; onRefresh: () => void; onDelete: (entity: ProductionEntity) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('character');
  const [descriptor, setDescriptor] = useState('');
  return <section className="production-panel"><header><div><h2>主体库</h2><p>角色、地点和道具使用不可变版本，镜头绑定具体版本。</p></div></header><form className="subject-create-form" onSubmit={(event) => { event.preventDefault(); if (!name.trim() || !descriptor.trim()) return; onAdd(name.trim(), kind, descriptor.trim()); setName(''); setDescriptor(''); }}><input aria-label="主体名称" placeholder="名称" value={name} onChange={(event) => setName(event.target.value)} /><select aria-label="主体类型" value={kind} onChange={(event) => setKind(event.target.value)}><option value="character">角色</option><option value="location">地点</option><option value="prop">道具</option></select><input aria-label="身份描述" placeholder="身份描述" value={descriptor} onChange={(event) => setDescriptor(event.target.value)} /><button className="studio-button" type="submit" disabled={busy || !name.trim() || !descriptor.trim()}><UserRound size={14} /> 新建主体</button></form><div className="production-card-grid">{subjects.map((subject) => <article className="production-card" key={subject.id}><header><b>{payloadText(subject, 'name') || subject.id}</b><span>{subjectKindLabel(payloadText(subject, 'kind') || 'character')}</span><button type="button" className="production-item-remove" title="删除主体" aria-label={`删除主体 ${payloadText(subject, 'name') || subject.id}`} onClick={() => { void onDelete(subject); }}><Trash2 size={12} /></button></header><p>{Array.isArray(subject.payload.aliases) ? `${subject.payload.aliases.length} 个别名` : '未设置别名'}</p><small>当前版本 v{String(subject.payload.currentVersion ?? 1)} · 修订 {subject.revision}</small><details className="subject-version-editor"><summary>添加版本</summary><SubjectVersionForm projectId={projectId} subject={subject} onRefresh={onRefresh} /></details></article>)}{!subjects.length && <div className="production-empty">还没有主体档案。</div>}</div></section>;
}

export function SubjectVersionForm({ projectId, subject, onRefresh }: { projectId?: string; subject: ProductionEntity; onRefresh: () => void }) {
  const [descriptor, setDescriptor] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    if (!projectId || !descriptor.trim()) return;
    const ordinal = Number(subject.payload.currentVersion ?? 1) + 1;
    setSaving(true);
    setError('');
    try { await applyProductionChange(projectId, crypto.randomUUID(), { [subject.id]: subject.revision }, [{ id: subject.id, kind: 'subject', op: 'createSubjectVersion', payload: { ...subject.payload, version: { ordinal, descriptor: descriptor.trim(), references: [] } } }]); setDescriptor(''); onRefresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  return <div className="subject-version-form"><textarea aria-label="新版本身份描述" value={descriptor} onChange={(event) => setDescriptor(event.target.value)} placeholder="新版本身份描述" /><button type="button" onClick={() => void save()} disabled={saving || !descriptor.trim()}>保存 v{Number(subject.payload.currentVersion ?? 1) + 1}</button>{error && <p className="production-error" role="alert">{error}</p>}</div>;
}

