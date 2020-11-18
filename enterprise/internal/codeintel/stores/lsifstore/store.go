package lsifstore

import (
	"context"
	"database/sql"

	"github.com/opentracing/opentracing-go/log"
	"github.com/sourcegraph/sourcegraph/internal/db/basestore"
	"github.com/sourcegraph/sourcegraph/internal/db/dbutil"
	"github.com/sourcegraph/sourcegraph/internal/observation"
)

type Store struct {
	*basestore.Store
	serializer *serializer
	operations *operations
}

func NewStore(db dbutil.DB, observationContext *observation.Context) *Store {
	return &Store{
		Store:      basestore.NewWithHandle(basestore.NewHandleWithDB(db, sql.TxOptions{})),
		serializer: newSerializer(),
		operations: makeOperations(observationContext),
	}
}

func (s *Store) Transact(ctx context.Context) (*Store, error) {
	tx, err := s.Store.Transact(ctx)
	if err != nil {
		return nil, err
	}

	return &Store{
		Store:      tx,
		serializer: s.serializer,
		operations: s.operations,
	}, nil
}

func (s *Store) Done(err error) error {
	return s.Store.Done(err)
}

func (s *Store) DocumentsReferencing(ctx context.Context, bundleID int, paths []string) (_ []string, err error) {
	ctx, endObservation := s.operations.documentsReferencing.With(ctx, &err, observation.Args{LogFields: []log.Field{
		log.Int("bundleID", bundleID),
	}})
	defer endObservation(1, observation.Args{})

	pathMap := map[string]struct{}{}
	for _, path := range paths {
		pathMap[path] = struct{}{}
	}

	meta, err := s.ReadMeta(ctx, bundleID)
	if err != nil {
		return nil, err
	}

	resultIDs := map[ID]struct{}{}
	for i := 0; i < meta.NumResultChunks; i++ {
		resultChunk, exists, err := s.ReadResultChunk(ctx, bundleID, i)
		if err != nil {
			return nil, err
		}
		if !exists {
			// TODO(efritz) - document that this should be fine
			continue
		}

		for resultID, documentIDRangeIDs := range resultChunk.DocumentIDRangeIDs {
			for _, documentIDRangeID := range documentIDRangeIDs {
				// Skip results that do not point into one of the given documents
				if _, ok := pathMap[resultChunk.DocumentPaths[documentIDRangeID.DocumentID]]; !ok {
					continue
				}

				resultIDs[resultID] = struct{}{}
			}
		}
	}

	allPaths, err := s.PathsWithPrefix(ctx, bundleID, "")
	if err != nil {
		return nil, err
	}

	var pathsReferencing []string
	for _, path := range allPaths {
		document, exists, err := s.ReadDocument(ctx, bundleID, path)
		if err != nil {
			return nil, err
		}
		if !exists {
			// TODO(efritz) - add error here - document should definitely exist
			continue
		}

		for _, r := range document.Ranges {
			if _, ok := resultIDs[r.DefinitionResultID]; ok {
				pathsReferencing = append(pathsReferencing, path)
				break
			}
		}
	}

	return pathsReferencing, nil
}
