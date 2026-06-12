"use client";

/**
 * /settings/categorization — Category Management ONLY.
 *
 * FINLYNQ-84 (2026-05-21) moved Transaction Rules out of this page into the
 * dedicated `/settings/rules` sub-page. The legacy single-field rule UI
 * (matchField/matchType/matchValue + assignCategoryId/assignTags/renameTo)
 * is gone — the new editor supports multi-condition rules + 7 action kinds.
 * See `pf-app/src/app/(app)/settings/rules/page.tsx` and
 * `pf-app/docs/transaction-rules-v2.md`.
 */

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tag, Plus, AlertTriangle, Pencil, Trash2, Check, X } from "lucide-react";

type Category = { id: number; type: string; group: string; name: string; note: string };

export default function CategorizationSettingsPage() {
  // Category management
  const [categories, setCategories] = useState<Category[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [catError, setCatError] = useState("");
  const [newCatForm, setNewCatForm] = useState({ name: "", type: "E", group: "" });
  const [newCatErrors, setNewCatErrors] = useState<{ name?: string; group?: string }>({});
  const [showAddCat, setShowAddCat] = useState(false);

  // Load categories
  const loadCategories = useCallback(() => {
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setCategories(Array.isArray(d) ? d : []))
      .catch(() => {
        setCategories([]);
        setCatError("Failed to load categories");
      });
  }, []);

  useEffect(() => { loadCategories(); }, [loadCategories]);

  // Category CRUD
  async function handleEditCategory(id: number) {
    if (!editName.trim()) return;
    setCatError("");
    try {
      const res = await fetch("/api/categories", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: editName.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        setCatError(data.error || "Failed to update");
        return;
      }
      setEditingId(null);
      setEditName("");
      loadCategories();
    } catch {
      setCatError("Failed to update category");
    }
  }

  async function handleDeleteCategory(id: number) {
    setCatError("");
    try {
      const res = await fetch(`/api/categories?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setCatError(data.error || "Failed to delete");
        return;
      }
      loadCategories();
    } catch {
      setCatError("Failed to delete category");
    }
  }

  async function handleAddCategory(e: React.FormEvent) {
    e.preventDefault();
    const errs: { name?: string; group?: string } = {};
    if (!newCatForm.name.trim()) errs.name = "Name is required";
    if (!newCatForm.group.trim()) errs.group = "Group is required";
    setNewCatErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setCatError("");
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCatForm.name.trim(), type: newCatForm.type, group: newCatForm.group.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        setCatError(data.error || "Failed to create");
        return;
      }
      setNewCatForm({ name: "", type: "E", group: "" });
      setNewCatErrors({});
      setShowAddCat(false);
      loadCategories();
    } catch {
      setCatError("Failed to create category");
    }
  }

  // Group categories by group
  const grouped = new Map<string, Category[]>();
  categories.forEach((c) => {
    const group = c.group || "Ungrouped";
    grouped.set(group, [...(grouped.get(group) ?? []), c]);
  });

  // Get unique groups for the add form
  const uniqueGroups = Array.from(new Set(categories.map((c) => c.group).filter(Boolean)));

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Categorization</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage transaction categories. Auto-categorization rules live in <a href="/settings/rules" className="underline hover:text-foreground">Rules</a>.</p>
      </div>

      {/* Category Management */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
                <Tag className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Category Management</CardTitle>
                <CardDescription>Manage transaction categories</CardDescription>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowAddCat(!showAddCat)}>
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {catError && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {catError}
            </div>
          )}

          {/* Add category form */}
          {showAddCat && (
            <form onSubmit={handleAddCategory} className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Name</Label>
                  <Input value={newCatForm.name} onChange={(e) => { setNewCatForm({ ...newCatForm, name: e.target.value }); setNewCatErrors({ ...newCatErrors, name: "" }); }} placeholder="Category name" />
                  {newCatErrors.name && <p className="text-xs text-destructive mt-1">{newCatErrors.name}</p>}
                </div>
                <div>
                  <Label>Group</Label>
                  <Input
                    value={newCatForm.group}
                    onChange={(e) => { setNewCatForm({ ...newCatForm, group: e.target.value }); setNewCatErrors({ ...newCatErrors, group: "" }); }}
                    placeholder="e.g. Housing"
                    list="cat-groups"
                  />
                  <datalist id="cat-groups">
                    {uniqueGroups.map((g) => <option key={g} value={g} />)}
                  </datalist>
                  {newCatErrors.group && <p className="text-xs text-destructive mt-1">{newCatErrors.group}</p>}
                </div>
                <div>
                  <Label>Type</Label>
                  <Select value={newCatForm.type} onValueChange={(v) => setNewCatForm({ ...newCatForm, type: v ?? "E" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="E">Expense</SelectItem>
                      <SelectItem value="I">Income</SelectItem>
                      <SelectItem value="R">Reconciliation</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">Add Category</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setShowAddCat(false); setNewCatErrors({}); }}>Cancel</Button>
              </div>
            </form>
          )}

          {/* Category list grouped */}
          {Array.from(grouped.entries()).map(([group, cats]) => (
            <div key={group}>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{group}</h4>
              <div className="space-y-1">
                {cats.map((cat) => (
                  <div key={cat.id} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/50 transition-colors group">
                    {editingId === cat.id ? (
                      <div className="flex items-center gap-2 flex-1">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="h-7 text-sm"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleEditCategory(cat.id);
                            if (e.key === "Escape") { setEditingId(null); setEditName(""); }
                          }}
                        />
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEditCategory(cat.id)} aria-label="Save category name">
                          <Check className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditingId(null); setEditName(""); }} aria-label="Cancel editing">
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{cat.name}</span>
                          <Badge variant="secondary" className="text-[10px]">
                            {cat.type === "E" ? "Expense" : cat.type === "I" ? "Income" : "Reconciliation"}
                          </Badge>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditingId(cat.id); setEditName(cat.name); setCatError(""); }} aria-label="Edit category">
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteCategory(cat.id)} aria-label="Delete category">
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {categories.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No categories found</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
