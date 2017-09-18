
import CloseIcon from '@sourcegraph/icons/lib/Close'
import FileIcon from '@sourcegraph/icons/lib/File'
import FileGlobIcon from '@sourcegraph/icons/lib/FileGlob'
import RepoIcon from '@sourcegraph/icons/lib/Repo'
import RepoGroupIcon from '@sourcegraph/icons/lib/RepoGroup'
import SearchIcon from '@sourcegraph/icons/lib/Search'
import escapeRegexp from 'escape-string-regexp'
import * as React from 'react'
import 'rxjs/add/observable/fromEvent'
import 'rxjs/add/observable/merge'
import 'rxjs/add/operator/catch'
import 'rxjs/add/operator/debounceTime'
import 'rxjs/add/operator/distinctUntilChanged'
import 'rxjs/add/operator/do'
import 'rxjs/add/operator/filter'
import 'rxjs/add/operator/map'
import 'rxjs/add/operator/repeat'
import 'rxjs/add/operator/switchMap'
import 'rxjs/add/operator/takeUntil'
import 'rxjs/add/operator/toArray'
import { Observable } from 'rxjs/Observable'
import { Subject } from 'rxjs/Subject'
import { Subscription } from 'rxjs/Subscription'
import { events } from 'sourcegraph/tracking/events'
import { scrollIntoView } from 'sourcegraph/util'
import { ParsedRouteProps } from 'sourcegraph/util/routes'
import { fetchSuggestions } from './backend'
import { buildSearchURLQuery, FileFilter, FileGlobFilter, Filter, FilterType, parseSearchURLQuery, RepoFilter, SearchOptions } from './index'

/** The icons used to show a suggestion for a filter */
const SUGGESTION_ICONS = {
    [FilterType.Repo]: RepoIcon,
    [FilterType.RepoGroup]: RepoGroupIcon,
    [FilterType.File]: FileIcon,
    [FilterType.FileGlob]: FileGlobIcon
}

function getFilterLabel(filter: Filter): string {
    return filter.value
}

interface Props extends ParsedRouteProps { }

interface State extends SearchOptions {

    /** Whether suggestions are shown or not */
    suggestionsVisible: boolean

    /** The suggestions shown to the user */
    suggestions: Filter[]

    /** Index of the currently selected suggestion (-1 if none selected) */
    selectedSuggestion: number
}

const shortcutModifier = navigator.platform.startsWith('Mac') ? 'Ctrl' : 'Cmd'

export class SearchBox extends React.Component<Props, State> {

    /** Subscriptions to unsubscribe from on component unmount */
    private subscriptions = new Subscription()

    /** Emits new input values */
    private inputValues = new Subject<string>()

    /** Emits when the input field is clicked */
    private inputClicks = new Subject<void>()

    /** Emits on componentWillReceiveProps */
    private componentUpdates = new Subject<Props>()

    /** Only used for selection and focus management */
    private inputElement?: HTMLInputElement

    /** Only used for scroll state management */
    private suggestionListElement?: HTMLElement

    /** Only used for scroll state management */
    private selectedSuggestionElement?: HTMLElement

    /** Only used for scroll state management */
    private chipsElement?: HTMLElement

    constructor(props: Props) {
        super(props)
        // Fill text input from URL info
        this.state = this.getStateFromProps(props)

        /** Emits whenever the route changes */
        const routeChanges = this.componentUpdates
            .distinctUntilChanged((a, b) => a.location === b.location)

        // Reset SearchBox on route changes
        this.subscriptions.add(
            routeChanges.subscribe(props => {
                this.setState(this.getStateFromProps(props))
            }, err => {
                console.error(err)
            })
        )

        this.subscriptions.add(
            Observable.merge(
                // Trigger new suggestions every time the input field is typed into
                this.inputValues
                    .do(query => this.setState({ query }))
                    .debounceTime(200),
                // Trigger new suggestions every time the input field is clicked
                this.inputClicks
                    .map(() => this.inputElement!.value)
            )
                .switchMap(query => {
                    if (query.length <= 1) {
                        this.setState({ suggestions: [], selectedSuggestion: -1 })
                        return []
                    }
                    // If query includes a wildcard, suggest a file glob filter
                    // TODO suggest repo glob filter (needs server implementation)
                    // TODO verify that the glob matches something server-side,
                    //      only suggest if it does and show number of matches
                    if (/^!|\*|\?/.exec(this.state.query)) {
                        const fileGlobFilter: FileGlobFilter = {
                            type: FilterType.FileGlob,
                            value: this.state.query
                        }
                        return [[fileGlobFilter]]
                    }
                    // Search repos
                    return fetchSuggestions(query, this.state.filters)
                        .map((item: GQL.SearchResult): Filter => {
                            switch (item.__typename) {
                                case 'Repository':    return { type: FilterType.Repo, value: item.uri }
                                case 'SearchProfile': return { type: FilterType.RepoGroup, value: item.name }
                                case 'File':          return { type: FilterType.File, value: item.name }
                            }
                        })
                        .toArray()
                        .catch(err => {
                            console.error(err)
                            return []
                        })
                })
                // Abort suggestion display on route change
                .takeUntil(routeChanges)
                // But resubscribe afterwards
                .repeat()
                .subscribe(suggestions => {
                    this.setState({ suggestions, selectedSuggestion: -1, suggestionsVisible: true })
                }, err => {
                    console.error(err)
                })
        )

        // Quick-Open hotkeys
        this.subscriptions.add(
            Observable.fromEvent<KeyboardEvent>(window, 'keydown')
                .filter(event =>
                    // Slash shortcut (if no input element is focused)
                    (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.nodeName))
                    // Cmd/Ctrl+P shortcut
                    || ((event.metaKey || event.ctrlKey) && event.key === 'p')
                    // Cmd/Ctrl+Shift+F shortcut
                    || ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'f')
                )
                .switchMap(event => {
                    event.preventDefault()
                    // For Cmd+Shift+F, use selection as query
                    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'f') {
                        const selection = window.getSelection().toString()
                        if (selection) {
                            return new Observable<void>(observer => this.setState({
                                query: selection,
                                suggestions: [],
                                selectedSuggestion: -1
                            }, () => {
                                observer.next()
                                observer.complete()
                            }))
                        }
                    }
                    return [undefined]
                })
                .subscribe(() => {
                    if (this.inputElement) {
                        // Select all input
                        this.inputElement.focus()
                        this.inputElement.setSelectionRange(0, this.inputElement.value.length)
                    }
                })
        )
    }

    public componentWillReceiveProps(newProps: Props): void {
        this.componentUpdates.next(newProps)
    }

    public componentDidMount(): void {
        this.focusInput()
    }

    public componentWillUnmount(): void {
        this.subscriptions.unsubscribe()
    }

    public componentDidUpdate(prevProps: Props, prevState: State): void {
        // Check if selected suggestion is out of view
        scrollIntoView(this.suggestionListElement, this.selectedSuggestionElement)
    }

    public render(): JSX.Element | null {
        const toHighlight = this.state.query.toLowerCase()
        const splitRegexp = new RegExp(`(${escapeRegexp(toHighlight)})`, 'gi')
        return (
            <form className='search-box' onSubmit={this.onSubmit}>
                <div className='search-box__query'>
                    <div className='search-box__search-icon'><SearchIcon /></div>
                    <div className='search-box__chips' ref={ref => this.chipsElement = ref || undefined}>
                        {
                            this.state.filters.map((filter, i) => {
                                const Icon = SUGGESTION_ICONS[filter.type]
                                const removeFilter = () => this.removeFilter(i)
                                return (
                                    <span key={i} className='search-box__chip'>
                                        <Icon />
                                        <span className='search-box__chip-text'>{getFilterLabel(filter)}</span>
                                        <button type='button' className='search-box__chip-remove-button' onClick={removeFilter}>
                                            <CloseIcon />
                                        </button>
                                    </span>
                                )
                            })
                        }
                        <input
                            type='search'
                            className='search-box__input'
                            value={this.state.query}
                            onChange={this.onInputChange}
                            onKeyDown={this.onInputKeyDown}
                            onBlur={this.onInputBlur}
                            onClick={this.onInputClick}
                            spellCheck={false}
                            autoCapitalize='off'
                            placeholder='Search'
                            ref={ref => this.inputElement = ref!}
                        />
                    </div>
                    <label className='search-box__option' title={`Match case (${shortcutModifier}+C)`}>
                        <input type='checkbox' checked={this.state.matchCase} onChange={this.toggleMatchCase} /><span>Aa</span>
                    </label>
                    <label className='search-box__option' title={`Match whole word (${shortcutModifier}+W)`}>
                        <input type='checkbox' checked={this.state.matchWord} onChange={this.toggleMatchWord} /><span><u>Ab</u></span>
                    </label>
                    <label className='search-box__option' title={`Match regular expression (${shortcutModifier}+R)`}>
                        <input type='checkbox' checked={this.state.matchRegex} onChange={this.toggleMatchRegex} /><span>.*</span>
                    </label>
                </div>
                <ul className='search-box__suggestions' style={this.state.suggestionsVisible ? {} : { height: 0 }} ref={this.setSuggestionListElement}>
                    {
                        this.state.suggestions.map((suggestion, i) => {
                            const onClick = () => {
                                this.setState({
                                    filters: this.state.filters.concat(suggestion),
                                    suggestions: [],
                                    selectedSuggestion: -1,
                                    query: ''
                                })
                            }
                            const onRef = ref => {
                                if (this.state.selectedSuggestion === i) {
                                    this.selectedSuggestionElement = ref || undefined
                                }
                            }
                            const Icon = SUGGESTION_ICONS[suggestion.type]
                            const parts = getFilterLabel(suggestion).split(splitRegexp)
                            let className = 'search-box__suggestion'
                            if (this.state.selectedSuggestion === i) {
                                className += ' search-box__suggestion--selected'
                            }
                            return (
                                <li
                                    key={i}
                                    className={className}
                                    onClick={onClick}
                                    ref={onRef}
                                >
                                    <Icon />
                                    <div className='search-box__suggestion-label'>
                                        {parts.map((part, i) => <span key={i} className={part.toLowerCase() === toHighlight ? 'search-box__highlighted-query' : ''}>{part}</span>)}
                                    </div>
                                    <div className='search-box__suggestion-tip' hidden={this.state.selectedSuggestion !== i}><kbd>enter</kbd> to add as filter</div>
                                </li>
                            )
                        })
                    }
                </ul>
            </form>
        )
    }

    private toggleMatchCase = () => this.setState({ matchCase: !this.state.matchCase })
    private toggleMatchWord = () => this.setState({ matchWord: !this.state.matchWord })
    private toggleMatchRegex = () => this.setState({ matchRegex: !this.state.matchRegex })

    private setSuggestionListElement = (ref: HTMLElement | null): void => {
        this.suggestionListElement = ref || undefined
    }

    private focusInput(): void {
        if (this.inputElement) {
            // Focus the input element and set cursor to the end
            this.inputElement.focus()
            this.inputElement.setSelectionRange(this.inputElement.value.length, this.inputElement.value.length)
        }
    }

    /**
     * Reads initial state from the props (i.e. URL parameters)
     */
    private getStateFromProps(props: Props): State {
        let searchOptions: SearchOptions = {
            query: '',
            filters: [],
            matchCase: false,
            matchWord: false,
            matchRegex: false
        }
        if (props.routeName === 'search') {
            // Search results page, show query
            searchOptions = parseSearchURLQuery(props.location.search)
        } else if (props.repoPath) {
            // Repo page, add repo filter
            searchOptions.filters.push({ type: FilterType.Repo, value: props.repoPath })
            if (props.filePath) {
                // Blob page, add file filter
                searchOptions.filters.push({ type: FilterType.File, value: props.filePath })
            }
        }
        return { ...searchOptions, suggestions: [], selectedSuggestion: -1, suggestionsVisible: false }
    }

    private removeFilter(index: number): void {
        const { filters } = this.state
        filters.splice(index, 1)
        this.setState({ filters })
    }

    private onInputChange: React.ChangeEventHandler<HTMLInputElement> = event => {
        this.inputValues.next(event.currentTarget.value)
    }

    private onInputBlur: React.FocusEventHandler<HTMLInputElement> = event => {
        this.setState({ suggestionsVisible: false })
    }

    private onInputClick: React.MouseEventHandler<HTMLInputElement> = event => {
        this.inputClicks.next()
    }

    private onInputKeyDown: React.KeyboardEventHandler<HTMLInputElement> = event => {
        switch (event.key) {
            case 'ArrowDown': {
                event.preventDefault()
                this.moveSelection(1)
                break
            }
            case 'ArrowUp': {
                event.preventDefault()
                this.moveSelection(-1)
                break
            }
            case 'Enter': {
                if (this.state.selectedSuggestion === -1) {
                    // Submit form
                    break
                }
                // fall through
            }
            case 'Tab': {
                event.preventDefault()
                if (this.state.suggestions.length === 0) {
                    break
                }
                this.setState({
                    filters: this.state.filters.concat(this.state.suggestions[Math.max(this.state.selectedSuggestion, 0)]),
                    suggestions: [],
                    selectedSuggestion: -1,
                    query: ''
                }, () => {
                    // Scroll chips so search input stays visible
                    if (this.chipsElement) {
                        this.chipsElement.scrollLeft = this.chipsElement.scrollWidth
                    }
                })
                break
            }
            case 'Backspace': {
                if (this.inputElement!.selectionStart === 0 && this.inputElement!.selectionEnd === 0) {
                    this.setState({ filters: this.state.filters.slice(0, -1) })
                }
                break
            }
            case 'r': {
                if (event.ctrlKey || event.metaKey) {
                    this.setState(prevState => ({ matchRegex: !prevState.matchRegex }))
                }
                break
            }
            case 'w': {
                if (event.ctrlKey || event.metaKey) {
                    this.setState(prevState => ({ matchWord: !prevState.matchWord }))
                }
                break
            }
            case 'c': {
                if (event.ctrlKey || event.metaKey) {
                    this.setState(prevState => ({ matchCase: !prevState.matchCase }))
                }
                break
            }
        }
    }

    private moveSelection(steps: number): void {
        this.setState({ selectedSuggestion: Math.max(Math.min(this.state.selectedSuggestion + steps, this.state.suggestions.length - 1), -1) })
    }

    /**
     * Called when the user submits the form (by pressing Enter)
     * If only one repo was selected and no query typed, redirects to the repo page
     * Otherwise redirects to the search results page
     */
    private onSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
        event.preventDefault()
        this.setState({ suggestionsVisible: false })
        if (this.state.filters.length === 0) {
            return
        }
        if (this.state.query) {
            // Go to search results
            const path = '/search?' + buildSearchURLQuery(this.state)
            events.SearchSubmitted.log({
                code_search: {
                    pattern: this.state.query,
                    repos: this.state.filters.filter(f => f.type === FilterType.Repo).map((f: RepoFilter) => f.value)
                }
            })
            this.props.history.push(path)
        } else if (this.state.filters[0].type === FilterType.Repo) {
            if (this.state.filters.length === 1) {
                // Go to repo
                this.props.history.push(`/${(this.state.filters[0] as RepoFilter).value}`)
            } else if (this.state.filters[1].type === FilterType.File && this.state.filters.length === 2) {
                // Go to file
                this.props.history.push(`/${(this.state.filters[0] as RepoFilter).value}/-/blob/${(this.state.filters[1] as FileFilter).value}`)
            }
        }
    }
}
