package gitserver

import (
	"context"
	"errors"
	"strings"

	"github.com/opentracing/opentracing-go/log"
	"github.com/sourcegraph/sourcegraph/internal/observation"
)

type Status uint8

const (
	Unchanged Status = iota
	Modified
	Deleted
	Added
)

func (c *Client) DiffFileStatus(ctx context.Context, repositoryID int, baseCommit, headCommit string) (_ map[string]Status, err error) {
	ctx, endObservation := c.operations.diffFileStatus.With(ctx, &err, observation.Args{LogFields: []log.Field{
		log.Int("repositoryID", repositoryID),
		log.String("baseCommit", baseCommit),
		log.String("headCommit", headCommit),
	}})
	defer endObservation(1, observation.Args{})

	output, err := c.execGitCommand(ctx, repositoryID, "diff", "--name-status", baseCommit, headCommit)
	if err != nil {
		return nil, err
	}

	statuses := make(map[string]Status)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || len(fields[0]) == 0 {
			continue
		}
		switch fields[0][0] {
		case 'M':
			statuses[fields[1]] = Modified
		case 'D':
			statuses[fields[1]] = Deleted
		case 'A':
			statuses[fields[1]] = Added
		case 'R':
			statuses[fields[1]] = Deleted
			statuses[fields[2]] = Added
		case 'C':
			statuses[fields[2]] = Added
		default:
			return nil, errors.New("unknown git diff file status")
		}
	}

	return statuses, nil
}
