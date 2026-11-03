# Git Internals

## 1. Git Objects

### Blob
Stores file contents.

### Tree
Represents directory structure and references blobs
and other trees.

### Commit
References a tree and its parent commit(s).

### Ref
A movable reference to a commit, such as main.

## 2. GitVault Archive Mechanism

When a file is archived:

1. Retrieve the current HEAD commit SHA.
2. Create a pointer containing the historical commit SHA.
3. Create a new blob containing the pointer.
4. Create a new tree that removes the original file
   and adds the pointer.
5. Create a commit referencing the new tree.
6. Move the branch reference to the new commit.

The original blob remains accessible through the
historical commit, provided Git retains the object.